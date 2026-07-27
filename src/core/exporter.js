import { createExportStore } from './export-store.js';
import { ApiRequestError } from '../api/api-errors.js';
import { compareMessageTuples, messageOrderKey, messageTuple } from './message-order.js';
import { normalizeStorageError } from './storage-capacity.js';

function messageTime(message) {
  if (typeof message?.messageTime === 'number' && Number.isFinite(message.messageTime)) {
    return message.messageTime;
  }
  const parsed = Date.parse(message?.messageTime || '');
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function textFromContents(contents) {
  const values = Array.isArray(contents) ? contents : [contents];
  return values
    .filter((content) => content && typeof content.text === 'string')
    .map((content) => `${content.speakerName || ''}:${content.text}`)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBookmark(bookmark) {
  const metadata = bookmark?.bookmark || bookmark || {};
  const message = bookmark?.message || metadata.message || {};
  const messageId = metadata.messageId ?? message.id;
  return {
    id: String(metadata.id ?? ''),
    roomId: String(metadata.roomId ?? message.roomId ?? ''),
    messageId: messageId === undefined || messageId === null ? '' : String(messageId),
    title: metadata.title || '',
    messageTime: message.messageTime ?? metadata.messageTime ?? null,
    previewText: textFromContents(message.contents ?? message.content),
  };
}

function bookmarkDateLabel(bookmark) {
  const time = messageTime({ messageTime: bookmark.messageTime });
  return Number.isFinite(time)
    ? new Intl.DateTimeFormat('ko-KR', {
      year: '2-digit', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(time))
    : '시간 정보 없음';
}

function bookmarkLabel(bookmark, dateLabel = bookmarkDateLabel(bookmark)) {
  const preview = bookmark.previewText || bookmark.title || '내용 미리보기 없음';
  return `${dateLabel} · ${preview.slice(0, 100)}`;
}

export async function listRoomBookmarks(roomId, api) {
  const bookmarks = (await api.getBookmarks(roomId))
    .map(normalizeBookmark)
    .filter((bookmark) => bookmark.id && bookmark.messageId)
    .sort((left, right) => compareMessageTuples(
      [messageOrderKey(left.messageTime), left.messageId],
      [messageOrderKey(right.messageTime), right.messageId],
    ));
  return bookmarks.map((bookmark) => {
    const dateLabel = bookmarkDateLabel(bookmark);
    return { ...bookmark, dateLabel, label: bookmarkLabel(bookmark, dateLabel) };
  });
}

export async function createRoomBookmark(roomId, messageId, api) {
  if (!/^MESSAGE-[A-Za-z0-9_-]+$/.test(messageId || '')) {
    throw new Error('선택한 메시지의 ID를 확인할 수 없습니다.');
  }
  const existing = await listRoomBookmarks(roomId, api);
  const duplicate = existing.find((bookmark) => bookmark.messageId === messageId);
  if (duplicate) {
    return { created: false, bookmark: duplicate };
  }

  const response = await api.createBookmark(roomId, messageId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const verified = (await listRoomBookmarks(roomId, api))
      .find((bookmark) => bookmark.messageId === messageId);
    if (verified) {
      return { created: true, bookmark: verified };
    }
  }

  const responseItem = response?.item || response;
  const responseBookmark = normalizeBookmark(responseItem);
  if (responseBookmark.id && responseBookmark.messageId === messageId) {
    return { created: true, bookmark: responseBookmark };
  }
  throw new Error('북마크 생성 응답을 확인할 수 없습니다. 목록을 새로고침해 확인해 주세요.');
}

async function validateBookmark(api, roomId, bookmark) {
  if (bookmark.roomId && bookmark.roomId !== String(roomId)) {
    throw new ApiRequestError('현재 대화방과 다른 북마크입니다.', { code: 'BOOKMARK_ROOM_MISMATCH' });
  }
  if (!bookmark.messageId || !bookmark.previewText) {
    throw new ApiRequestError('북마크의 메시지 앵커 또는 미리보기를 확인할 수 없습니다.', {
      code: 'INVALID_BOOKMARK',
    });
  }

  const anchorRequest = { parameter: 'cursor', value: `${roomId}:${bookmark.messageId}` };
  const firstPage = await api.getMessagesPage(roomId, anchorRequest, 10);
  const candidates = [{ page: firstPage, request: anchorRequest }];
  if (!Array.isArray(firstPage.messages)) {
    throw new ApiRequestError('메시지 목록 응답 형식이 올바르지 않습니다.', { code: 'INVALID_RESPONSE' });
  }
  if (!firstPage.messages.some((message) => String(message.id) === bookmark.messageId)) {
    for (const parameter of ['cursor', 'prevCursor']) {
      const value = parameter === 'cursor' ? firstPage.nextCursor : firstPage.prevCursor;
      if (!value) {
        continue;
      }
      const request = { parameter, value };
      const page = await api.getMessagesPage(roomId, request, 10);
      if (!Array.isArray(page.messages)) {
        continue;
      }
      candidates.push({ page, request });
      if (page.messages.some((message) => String(message.id) === bookmark.messageId)) {
        break;
      }
    }
  }

  for (const candidate of candidates) {
    const message = candidate.page.messages.find(
      (item) => String(item.id) === bookmark.messageId,
    );
    if (!message) {
      continue;
    }
    if (textFromContents(message.contents ?? message.content) !== bookmark.previewText) {
      throw new ApiRequestError('북마크 메시지의 내용이 저장된 미리보기와 일치하지 않습니다.', {
        code: 'BOOKMARK_PREVIEW_MISMATCH',
      });
    }
    if (!messageOrderKey(message.messageTime)) {
      throw new ApiRequestError('북마크 메시지의 시간 정보를 확인할 수 없습니다.', {
        code: 'INVALID_BOOKMARK_TIME',
      });
    }
    return { ...candidate, message, anchorRequest };
  }
  throw new ApiRequestError(
    '북마크 앵커를 확인할 수 없습니다. Zeta에서 북마크를 다시 만든 뒤 재시도해 주세요.',
    { code: 'BOOKMARK_NOT_FOUND' },
  );
}

function pageBoundary(page) {
  const tuples = page.messages
    .map(messageTuple)
    .filter((value) => value[0] !== null)
    .sort(compareMessageTuples);
  return tuples.at(-1);
}

async function detectForwardDirection(api, roomId, startPage, endMessageId) {
  if (startPage.messages.some((message) => String(message.id) === endMessageId)) {
    return null;
  }
  const startBoundary = pageBoundary(startPage);
  const candidates = [];
  for (const parameter of ['cursor', 'prevCursor']) {
    const value = parameter === 'cursor' ? startPage.nextCursor : startPage.prevCursor;
    if (!value) {
      continue;
    }
    try {
      const page = await api.getMessagesPage(roomId, { parameter, value }, 10);
      if (!Array.isArray(page.messages)) {
        continue;
      }
      const boundary = pageBoundary(page);
      if (boundary && compareMessageTuples(boundary, startBoundary) > 0) {
        candidates.push({
          parameter, boundary, reachesEnd: page.messages.some(
            (message) => String(message.id) === endMessageId,
          )
        });
      }
    } catch (error) {
      if (error?.retryable) {
        throw error;
      }
    }
  }
  candidates.sort((left, right) => {
    if (left.reachesEnd !== right.reachesEnd) {
      return left.reachesEnd ? -1 : 1;
    }
    return compareMessageTuples(left.boundary, right.boundary);
  });
  if (!candidates.length) {
    throw new ApiRequestError('북마크 사이의 API cursor 방향을 확인할 수 없습니다.', {
      code: 'CURSOR_DIRECTION_UNKNOWN',
    });
  }
  return candidates[0].parameter;
}

async function initializeRangeJob(store, api, job) {
  const allBookmarks = (await api.getBookmarks(job.roomId)).map(normalizeBookmark);
  const startBookmark = allBookmarks.find((bookmark) => bookmark.id === job.range.startBookmarkId);
  const endBookmark = allBookmarks.find((bookmark) => bookmark.id === job.range.endBookmarkId);
  if (!startBookmark || !endBookmark) {
    throw new ApiRequestError('선택한 북마크를 다시 찾을 수 없습니다.', { code: 'BOOKMARK_NOT_FOUND' });
  }
  const start = await validateBookmark(api, job.roomId, startBookmark);
  const end = await validateBookmark(api, job.roomId, endBookmark);
  const startTuple = messageTuple(start.message);
  const endTuple = messageTuple(end.message);
  if (compareMessageTuples(startTuple, endTuple) > 0) {
    throw new ApiRequestError('시작 북마크가 끝 북마크보다 뒤에 있습니다.', {
      code: 'REVERSED_RANGE',
    });
  }
  const direction = await detectForwardDirection(
    api,
    job.roomId,
    start.page,
    endBookmark.messageId,
  );
  return store.configureCollection(job.jobId, {
    phase: 'ready',
    anchorRequest: start.anchorRequest,
    direction,
    startTuple,
    endTuple,
    endMessageId: endBookmark.messageId,
    lastBoundary: null,
  });
}

function filterRangeMessages(messages, startTuple, endTuple) {
  return messages.filter((message) => {
    const value = messageTuple(message);
    return value[0] !== null
      && compareMessageTuples(value, startTuple) >= 0
      && compareMessageTuples(value, endTuple) <= 0;
  });
}

function nextRequestForPage(page, direction) {
  const value = direction === 'prevCursor' ? page.prevCursor : page.nextCursor;
  return value ? { parameter: direction || 'cursor', value } : null;
}

export async function collectRoomToStore({ roomId, store, api, job, onProgress = async () => { } }) {
  let currentJob = job;
  if (currentJob.state === 'assembling') {
    return currentJob;
  }
  if (currentJob.state === 'paused') {
    currentJob = await store.setState(currentJob.jobId, 'collecting');
  }

  try {
    if (currentJob.range.type === 'bookmarks' && currentJob.collection.phase !== 'ready') {
      currentJob = await initializeRangeJob(store, api, currentJob);
    }

    do {
      const isFirstRangePage = currentJob.range.type === 'bookmarks' && currentJob.pageCount === 0;
      const requestCursor = isFirstRangePage
        ? currentJob.collection.anchorRequest
        : currentJob.nextRequest;
      const page = await api.getMessagesPage(roomId, requestCursor);
      if (!Array.isArray(page.messages)) {
        throw new ApiRequestError('메시지 목록 응답 형식이 올바르지 않습니다.', {
          code: 'INVALID_RESPONSE',
        });
      }

      let messages = page.messages;
      let finished;
      let nextRequest;
      const checkpoint = {};
      if (currentJob.range.type === 'bookmarks') {
        const collection = currentJob.collection;
        const reachedEnd = page.messages.some(
          (message) => String(message.id) === collection.endMessageId,
        );
        const boundary = pageBoundary(page);
        if (collection.lastBoundary && boundary
          && compareMessageTuples(boundary, collection.lastBoundary) <= 0) {
          throw new ApiRequestError('메시지 cursor가 앞으로 진행하지 않아 수집을 중단했습니다.', {
            code: 'CURSOR_NOT_ADVANCING',
          });
        }
        messages = filterRangeMessages(page.messages, collection.startTuple, collection.endTuple);
        finished = reachedEnd;
        nextRequest = finished ? null : nextRequestForPage(page, collection.direction);
        if (!finished && !nextRequest) {
          throw new ApiRequestError('끝 북마크에 도달하기 전에 메시지 cursor가 종료되었습니다.', {
            code: 'END_BOOKMARK_NOT_REACHED',
          });
        }
        checkpoint.lastBoundary = boundary;
      } else {
        nextRequest = page.nextCursor
          ? { parameter: 'cursor', value: page.nextCursor }
          : null;
        finished = !nextRequest;
        if (currentJob.nextRequest?.value && nextRequest?.value === currentJob.nextRequest.value) {
          throw new ApiRequestError('메시지 cursor가 반복되어 수집을 중단했습니다.', {
            code: 'REPEATED_CURSOR',
          });
        }
      }

      currentJob = await store.savePage(currentJob.jobId, messages, {
        nextRequest,
        finished,
        checkpoint,
      });
      await onProgress(currentJob);
    } while (currentJob.state === 'collecting');
    return currentJob;
  }
  catch (error) {
    const normalizedError = normalizeStorageError(error);
    if (normalizedError?.retryable) {
      await store.pauseJob(currentJob.jobId, normalizedError);
    }
    else {
      await store.failJob(currentJob.jobId, normalizedError);
    }
    throw normalizedError;
  }
}

export async function resolveExportJob({
  roomId,
  format = 'json',
  range = { type: 'all' },
  jobId,
  store = createExportStore(),
}) {
  let job = jobId ? await store.getJob(jobId) : null;
  if (jobId && !job) {
    throw new Error('이어받을 작업을 찾을 수 없습니다.');
  }
  if (job && job.roomId !== roomId) {
    throw new Error('현재 대화방의 작업이 아닙니다.');
  }
  if (job?.state === 'assembling') {
    return job;
  }
  if (job && !['collecting', 'paused'].includes(job.state)) {
    throw new Error('이 작업은 이어받을 수 없습니다.');
  }
  if (!job) {
    job = await store.createJob({
      roomId,
      format,
      range,
      collection: range.type === 'bookmarks' ? { phase: 'validating' } : { phase: 'ready' },
    });
  }
  return job;
}

export { compareMessageTuples as compareTuple, normalizeBookmark, validateBookmark };
