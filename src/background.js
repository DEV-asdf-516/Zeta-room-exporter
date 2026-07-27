import { createMessageApi } from './api/message-api.js';
import { createZetaRequest } from './api/zeta-http.js';
import { downloadDiagnosticLog, downloadExportJob } from './core/download.js';
import { createExportStore } from './core/export-store.js';
import {
  collectRoomToStore,
  createRoomBookmark,
  listRoomBookmarks,
  resolveExportJob,
} from './core/exporter.js';
import { assertStorageCapacity, getStorageStatus } from './core/storage-capacity.js';
import { withZetaReadRetry } from './api/zeta-api-retry.js';

const activeRooms = new Map();
const BOOKMARK_CONTEXT_MENU_ID = 'zeta-add-message-bookmark';
const REQUEST_TYPES = new Set([
  'GET_EXPORT_CONTEXT',
  'GET_BOOKMARKS',
  'DELETE_EXPORT_JOB',
  'DOWNLOAD_DIAGNOSTICS',
  'START_EXPORT',
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!REQUEST_TYPES.has(message?.type)) {
    return;
  }
  handleMessage(message)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => {
      console.error('Zeta export failed:', error);
      sendResponse({
        ok: false,
        error: error.message || '요청에 실패했습니다.',
        retryable: Boolean(error.retryable),
      });
    });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: BOOKMARK_CONTEXT_MENU_ID,
    title: '북마크 추가',
    contexts: ['all'],
    documentUrlPatterns: ['https://zeta-ai.io/*'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== BOOKMARK_CONTEXT_MENU_ID || !tab?.id || !tab.url) {
    return;
  }
  addBookmarkFromContextMenu(tab).catch(async (error) => {
    console.error('Zeta bookmark creation failed:', error);
    await showBookmarkResult(
      tab.id,
      error.message || '북마크 추가에 실패했습니다.',
      true,
    );
  });
});

async function addBookmarkFromContextMenu(tab) {
  const roomId = getRoomId(tab.url);
  if (!roomId) {
    throw new Error('Zeta 대화방에서 메시지를 선택해 주세요.');
  }
  let target;
  try {
    target = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTEXT_MESSAGE' });
  } catch {
    throw new Error('Zeta 페이지를 새로고침한 뒤 다시 시도해 주세요.');
  }
  if (!target?.messageId) {
    throw new Error('이 위치에서 메시지를 확인할 수 없습니다. 메시지 본문을 우클릭해 주세요.');
  }
  const result = await createRoomBookmark(roomId, target.messageId, await createZetaApi());
  const message = result.created
    ? '북마크를 추가했습니다.'
    : '이미 북마크된 메시지입니다.';
  await showBookmarkResult(tab.id, message, false);
}

async function showBookmarkResult(tabId, message, isError) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SHOW_BOOKMARK_RESULT', message, isError });
  } catch {
    // The page may have navigated before the result was ready.
  }
}

async function handleMessage(message) {
  const roomId = await getCurrentRoomId();
  const store = createExportStore();

  if (message.type === 'GET_EXPORT_CONTEXT') {
    const completed = await store.findLatestJob({ roomId, states: ['completed'] });
    if (completed) {
      await store.deleteJob(completed.jobId);
    }
    return {
      roomId,
      active: activeRooms.has(roomId),
      storageWarning: (await getStorageStatus()).warning,
      job: await store.findLatestPublicJob({
        roomId,
        states: ['collecting', 'paused', 'assembling', 'failed'],
      }),
    };
  }

  if (message.type === 'GET_BOOKMARKS') {
    return { bookmarks: await listRoomBookmarks(roomId, await createZetaApi()) };
  }

  if (message.type === 'DELETE_EXPORT_JOB') {
    if (activeRooms.has(roomId)) {
      throw new Error('진행 중인 작업은 삭제할 수 없습니다.');
    }
    const job = await store.getJob(message.jobId);
    if (!job || job.roomId !== roomId) {
      throw new Error('삭제할 작업을 찾을 수 없습니다.');
    }
    await store.deleteJob(job.jobId);
    await notify({ type: 'EXPORT_JOB_DELETED', jobId: job.jobId });
    return {};
  }

  if (message.type === 'DOWNLOAD_DIAGNOSTICS') {
    const job = await store.getJob(message.jobId);
    if (!job || job.roomId !== roomId) {
      throw new Error('진단할 작업을 찾을 수 없습니다.');
    }
    await downloadDiagnosticLog(await store.getDiagnosticLog(job.jobId));
    return {};
  }

  if (message.type !== 'START_EXPORT') {
    throw new Error('지원하지 않는 요청입니다.');
  }
  if (activeRooms.has(roomId)) {
    throw new Error('이 대화방의 내보내기가 이미 진행 중입니다.');
  }
  if (!message.jobId) {
    await assertStorageCapacity();
  }

  const format = message.format === 'txt' ? 'txt' : 'json';
  const range = normalizeRange(message.range);
  const operation = runExport({
    roomId,
    format,
    range,
    jobId: message.jobId,
    store,
  });
  activeRooms.set(roomId, operation);
  try {
    return await operation;
  } finally {
    if (activeRooms.get(roomId) === operation) {
      activeRooms.delete(roomId);
    }
  }
}

async function runExport({ roomId, format, range, jobId, store }) {
  let preparedJob;
  try {
    preparedJob = await resolveExportJob({
      roomId,
      format,
      range,
      jobId,
      store,
    });
    if (preparedJob.state !== 'assembling') {
      const api = await createZetaApi({
        onRetry: async (event) => {
          await store.addDiagnostic(preparedJob.jobId, event);
          await notify({
            type: 'EXPORT_RETRY',
            roomId,
            jobId: preparedJob.jobId,
            status: event.status,
            waitMs: event.waitMs,
          });
        },
      });
      preparedJob = await collectRoomToStore({
        roomId,
        store,
        api,
        job: preparedJob,
        onProgress: async (job) => {
          await notify({
            type: 'EXPORT_PROGRESS',
            roomId,
            job: await store.getPublicJob(job.jobId),
          });
        },
      });
    }
    await notify({ type: 'EXPORT_PROGRESS', roomId, job: await store.getPublicJob(preparedJob.jobId) });
    const result = await downloadExportJob(store, preparedJob, async ({ part }) => {
      await notify({ type: 'EXPORT_ASSEMBLY_PROGRESS', roomId, jobId: preparedJob.jobId, part });
    });
    await store.setState(preparedJob.jobId, 'completed');
    await notify({
      type: 'EXPORT_COMPLETED',
      roomId,
      jobId: preparedJob.jobId,
      messageCount: preparedJob.messageCount,
      fileCount: result.fileCount,
      format: preparedJob.format,
    });
    await store.deleteJob(preparedJob.jobId);
    return {
      messageCount: preparedJob.messageCount,
      fileCount: result.fileCount,
      format: preparedJob.format,
    };
  } catch (error) {
    const failedJobId = preparedJob?.jobId || error.jobId || jobId;
    if (failedJobId) {
      const job = await store.getPublicJob(failedJobId);
      error.retryable = job?.state === 'paused' || job?.state === 'assembling';
      await notify({ type: 'EXPORT_FAILED', roomId, job, error: error.message, retryable: error.retryable });
    }
    throw error;
  }
}

async function createZetaApi({ onRetry = async () => {} } = {}) {
  const cookie = await chrome.cookies.get({ url: 'https://zeta-ai.io', name: 'TOKEN' });
  if (!cookie?.value) {
    throw new Error('Zeta에 로그인해 주세요.');
  }
  const request = withZetaReadRetry(createZetaRequest(cookie.value), { onRetry });
  return createMessageApi(request);
}

function normalizeRange(range) {
  if (range?.type !== 'bookmarks') {
    return { type: 'all' };
  }
  if (!range.startBookmarkId || !range.endBookmarkId) {
    throw new Error('시작과 끝 북마크를 모두 선택해 주세요.');
  }
  return {
    type: 'bookmarks',
    startBookmarkId: String(range.startBookmarkId),
    endBookmarkId: String(range.endBookmarkId),
  };
}

async function notify(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // The popup may be closed while a background export continues.
  }
}

async function getCurrentRoomId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) {
    throw new Error('현재 탭을 찾을 수 없습니다.');
  }
  const roomId = getRoomId(tab.url);
  if (!roomId) {
    throw new Error('현재 페이지 URL에서 Room ID를 찾을 수 없습니다. Zeta 대화방을 연 뒤 다시 시도하세요.');
  }
  return roomId;
}

function getRoomId(urlString) {
  const url = new URL(urlString);
  for (const key of ['roomId', 'room_id', 'room']) {
    const value = url.searchParams.get(key);
    if (value) {
      return value;
    }
  }
  const match = url.pathname.match(/\/(?:rooms?|chat)\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

export { getRoomId, normalizeRange };
