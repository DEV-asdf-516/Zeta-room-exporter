import assert from 'node:assert/strict';
import test from 'node:test';

import { assembleExportParts } from '../src/core/assembly.js';
import { downloadExportJob } from '../src/core/download.js';
import { publicJob } from '../src/core/export-store.js';
import {
  collectRoomToStore,
  createRoomBookmark,
  listRoomBookmarks,
  normalizeBookmark,
  resolveExportJob,
} from '../src/core/exporter.js';
import { ApiRequestError } from '../src/api/api-errors.js';
import { createMessageApi } from '../src/api/message-api.js';
import { createZetaRequest } from '../src/api/zeta-http.js';
import { compareMessageTuples, messageOrderKey, messageTuple } from '../src/core/message-order.js';
import {
  assertStorageCapacity,
  getStorageStatus,
  normalizeStorageError,
  StorageCapacityError,
} from '../src/core/storage-capacity.js';
import { advanceBookmarkRange, bookmarkRangeBounds } from '../src/core/range-selection.js';
import { withRetry } from '../src/core/retry.js';
import { withZetaReadRetry } from '../src/api/zeta-api-retry.js';
import '../src/content/message-context.js';

function createRetriedTestApi(token, {
  fetchImpl,
  delay = async () => {},
  random = Math.random,
  onRetry = async () => {},
} = {}) {
  const request = createZetaRequest(token, { fetchImpl, delay });
  return createMessageApi(withZetaReadRetry(request, { delay, random, onRetry }));
}

function createRawTestApi(token, options) {
  return createMessageApi(createZetaRequest(token, options));
}

function createMemoryStore() {
  const jobs = new Map();
  const records = new Map();
  let nextJob = 1;

  function update(jobId, change) {
    const job = { ...jobs.get(jobId), ...change, updatedAt: Date.now() };
    jobs.set(jobId, job);
    return job;
  }

  return {
    jobs,
    records,
    async createJob({ roomId, format, range = { type: 'all' }, collection = {} }) {
      const job = {
        jobId: `job-${nextJob++}`,
        roomId,
        format,
        range,
        collection,
        state: 'collecting',
        nextRequest: null,
        messageCount: 0,
        pageCount: 0,
        estimatedBytes: 0,
        diagnostics: [],
        updatedAt: Date.now(),
      };
      jobs.set(job.jobId, job);
      records.set(job.jobId, new Map());
      return job;
    },
    async getJob(jobId) { return jobs.get(jobId); },
    async getPublicJob(jobId) { return publicJob(jobs.get(jobId)); },
    async setState(jobId, state) { return update(jobId, { state }); },
    async configureCollection(jobId, collection) {
      const job = jobs.get(jobId);
      return update(jobId, {
        collection: { ...job.collection, ...collection },
        nextRequest: collection.nextRequest ?? job.nextRequest,
      });
    },
    async savePage(jobId, messages, { nextRequest, finished, checkpoint = {} }) {
      const stored = records.get(jobId);
      let bytes = 0;
      for (const message of messages) {
        stored.set(String(message.id), message);
        bytes += Buffer.byteLength(JSON.stringify(message));
      }
      const job = jobs.get(jobId);
      return update(jobId, {
        collection: { ...job.collection, ...checkpoint },
        state: finished ? 'assembling' : 'collecting',
        nextRequest,
        messageCount: stored.size,
        pageCount: job.pageCount + 1,
        estimatedBytes: job.estimatedBytes + bytes,
      });
    },
    async pauseJob(jobId, error) {
      return update(jobId, { state: 'paused', lastError: { code: error.status || error.code } });
    },
    async failJob(jobId, error) {
      return update(jobId, { state: 'failed', lastError: { code: error.status || error.code } });
    },
    async addDiagnostic(jobId, event) {
      const job = jobs.get(jobId);
      return update(jobId, { diagnostics: [...job.diagnostics, event] });
    },
    async readMessages(jobId, { afterKey, limit = 250 }) {
      const sorted = [...records.get(jobId).values()].sort((left, right) => {
        return compareMessageTuples(messageTuple(left), messageTuple(right));
      });
      const start = afterKey || 0;
      const messages = sorted.slice(start, start + limit);
      const end = start + messages.length;
      return { messages, nextKey: end < sorted.length ? end : null };
    },
  };
}

function message(id, textSize = 16) {
  return {
    id: String(id),
    roomId: 'room-1',
    messageTime: id,
    contents: [{ speakerName: id % 2 ? 'A' : 'B', text: 'x'.repeat(textSize) }],
  };
}

function createPagedApi(total, { failPage } = {}) {
  const calls = [];
  return {
    calls,
    async getMessagesPage(roomId, requestCursor) {
      const pageIndex = requestCursor?.value ? Number(requestCursor.value.slice(2)) : 0;
      calls.push({ roomId, pageIndex });
      if (pageIndex === failPage) {
        throw new ApiRequestError('rate limited', { status: 429, retryable: true });
      }
      const start = pageIndex * 100;
      const count = Math.min(100, total - start);
      const messages = Array.from({ length: count }, (_, offset) => {
        const id = start + offset + 1;
        return message(id, 1024 * (1 + (id % 5)));
      });
      const next = start + count < total ? `c-${pageIndex + 1}` : null;
      return { messages, nextCursor: next };
    },
  };
}

test('20,000 messages are checkpointed across 200 pages and assembled in valid parts', async () => {
  const store = createMemoryStore();
  const api = createPagedApi(20_000);
  let job = await store.createJob({ roomId: 'room-1', format: 'json' });
  job = await collectRoomToStore({ roomId: 'room-1', store, api, job });

  assert.equal(job.state, 'assembling');
  assert.equal(job.pageCount, 200);
  assert.equal(job.messageCount, 20_000);
  assert.equal(api.calls.length, 200);

  let total = 0;
  let previousId = 0;
  let partCount = 0;
  for await (const part of assembleExportParts(store, job)) {
    assert.match(part.content, /^\{\n  "messages": \[\n/);
    const payload = JSON.parse(part.content);
    assert.ok(payload.messages.length <= 1000);
    for (const item of payload.messages) {
      assert.ok(Number(item.id) > previousId);
      previousId = Number(item.id);
    }
    total += payload.messages.length;
    partCount += 1;
  }
  assert.equal(total, 20_000);
  assert.ok(partCount > 20, 'long contents trigger byte-size partitioning as well');
});

test('a repeated 429 on page 151 pauses with 15,000 messages and resumes there', async () => {
  const store = createMemoryStore();
  let job = await store.createJob({ roomId: 'room-1', format: 'json' });
  const failingApi = createPagedApi(20_000, { failPage: 150 });
  await assert.rejects(
    collectRoomToStore({ roomId: 'room-1', store, api: failingApi, job }),
    /rate limited/,
  );

  job = store.jobs.get(job.jobId);
  assert.equal(job.state, 'paused');
  assert.equal(job.pageCount, 150);
  assert.equal(job.messageCount, 15_000);
  assert.equal(job.nextRequest.value, 'c-150');

  const resumedApi = createPagedApi(20_000);
  job = await collectRoomToStore({ roomId: 'room-1', store, api: resumedApi, job });
  assert.equal(resumedApi.calls[0].pageIndex, 150);
  assert.equal(job.state, 'assembling');
  assert.equal(job.messageCount, 20_000);
});

test('a transient 429 is retried by the API client without losing pacing', async () => {
  const delays = [];
  const retries = [];
  let requestCount = 0;
  const api = createRetriedTestApi('test-token', {
    delay: async (milliseconds) => { delays.push(milliseconds); },
    random: () => 0,
    onRetry: async (event) => { retries.push(event); },
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return { ok: false, status: 429 };
      }
      return { ok: true, status: 200, json: async () => ({ messages: [], nextCursor: null }) };
    },
  });

  await api.getMessagesPage('room-1');
  assert.equal(requestCount, 2);
  assert.deepEqual(delays, [500, 5000, 500]);
  assert.deepEqual(retries, [{ kind: 'http', status: 429, attempt: 1, waitMs: 5000 }]);
});

test('a 429 on page 51 retries that page and collection continues', async () => {
  const store = createMemoryStore();
  let job = await store.createJob({ roomId: 'room-1', format: 'json' });
  const attempts = new Map();
  const api = createRetriedTestApi('test-token', {
    delay: async () => {},
    random: () => 0,
    fetchImpl: async (url) => {
      const cursor = new URL(url).searchParams.get('cursor');
      const pageIndex = cursor ? Number(cursor.slice(2)) : 0;
      attempts.set(pageIndex, (attempts.get(pageIndex) || 0) + 1);
      if (pageIndex === 50 && attempts.get(pageIndex) === 1) {
        return { ok: false, status: 429 };
      }
      const start = pageIndex * 100;
      const count = Math.min(100, 5200 - start);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            messages: Array.from({ length: count }, (_, offset) => message(start + offset + 1)),
            nextCursor: start + count < 5200 ? `c-${pageIndex + 1}` : null,
          };
        },
      };
    },
  });
  job = await collectRoomToStore({ roomId: 'room-1', store, api, job });
  assert.equal(attempts.get(50), 2);
  assert.equal(job.pageCount, 52);
  assert.equal(job.messageCount, 5200);
});

test('network and 5xx errors use exponential retries before succeeding', async () => {
  const retries = [];
  let attempt = 0;
  const api = createRetriedTestApi('test-token', {
    delay: async () => {},
    onRetry: async (event) => { retries.push(event); },
    fetchImpl: async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new TypeError('offline');
      }
      if (attempt === 2) {
        return { ok: false, status: 503 };
      }
      return { ok: true, status: 200, json: async () => ({ messages: [] }) };
    },
  });
  await api.getMessagesPage('room-1');
  assert.equal(attempt, 3);
  assert.deepEqual(retries.map(({ kind, status, waitMs }) => ({ kind, status, waitMs })), [
    { kind: 'network', status: undefined, waitMs: 1000 },
    { kind: 'http', status: 503, waitMs: 2000 },
  ]);
});

test('bookmark pagination retries only the failed GET page', async () => {
  const cursors = [];
  let secondPageAttempts = 0;
  const api = createRetriedTestApi('test-token', {
    delay: async () => {},
    fetchImpl: async (url) => {
      const cursor = new URL(url).searchParams.get('cursor');
      cursors.push(cursor);
      if (!cursor) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [], nextCursor: 'page-2' }),
        };
      }
      secondPageAttempts += 1;
      if (secondPageAttempts === 1) {
        return { ok: false, status: 503 };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [], nextCursor: null }),
      };
    },
  });
  await api.getBookmarks('room-1');
  assert.deepEqual(cursors, [null, 'page-2', 'page-2']);
});

test('bookmark A to B includes both anchors and only messages between them', async () => {
  const store = createMemoryStore();
  const bookmarks = [
    { id: 'a', messageId: '5', roomId: 'room-1', message: message(5) },
    { id: 'b', messageId: '15', roomId: 'room-1', message: message(15) },
  ];
  const rangeApi = {
    async getBookmarks() { return bookmarks; },
    async getMessagesPage(roomId, request) {
      if (request?.value === 'room-1:5') {
        return { messages: Array.from({ length: 10 }, (_, i) => message(i + 1)), nextCursor: 'page-2' };
      }
      if (request?.value === 'room-1:15' || request?.value === 'page-2') {
        return { messages: Array.from({ length: 10 }, (_, i) => message(i + 11)), nextCursor: null };
      }
      throw new Error(`unexpected cursor: ${request?.value}`);
    },
  };

  let job = await resolveExportJob({
    roomId: 'room-1',
    format: 'json',
    range: { type: 'bookmarks', startBookmarkId: 'a', endBookmarkId: 'b' },
    store,
  });
  job = await collectRoomToStore({ roomId: 'room-1', store, api: rangeApi, job });
  assert.equal(job.state, 'assembling');
  assert.equal(job.messageCount, 11);
  assert.deepEqual([...store.records.get(job.jobId).keys()],
    Array.from({ length: 11 }, (_, index) => String(index + 5)));
});

test('a bookmark preview mismatch fails safely without storing another range', async () => {
  const store = createMemoryStore();
  const rangeApi = {
    async getBookmarks() {
      return [
        { id: 'a', messageId: '5', roomId: 'room-1', message: message(5) },
        { id: 'b', messageId: '6', roomId: 'room-1', message: message(6) },
      ];
    },
    async getMessagesPage(roomId, request) {
      const id = Number(request.value.split(':').at(-1));
      return { messages: [{ ...message(id), contents: [{ speakerName: 'A', text: 'changed' }] }] };
    },
  };

  await assert.rejects(
    async () => {
      const job = await resolveExportJob({
        roomId: 'room-1',
        range: { type: 'bookmarks', startBookmarkId: 'a', endBookmarkId: 'b' },
        store,
      });
      await collectRoomToStore({ roomId: 'room-1', store, api: rangeApi, job });
    },
    /일치하지 않습니다/,
  );
  const [job] = store.jobs.values();
  assert.equal(job.state, 'failed');
  assert.equal(job.messageCount, 0);
});

test('large downloads create valid part files and a non-sensitive manifest', async () => {
  const store = createMemoryStore();
  let job = await store.createJob({ roomId: 'room/unsafe', format: 'json' });
  const messages = Array.from({ length: 5000 }, (_, index) => message(index + 1, 4));
  job = await store.savePage(job.jobId, messages, { finished: true });
  const downloads = [];
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    downloads: {
      async download(options) { downloads.push(options); return downloads.length; },
    },
  };
  try {
    const result = await downloadExportJob(store, job);
    assert.equal(result.fileCount, 6);
    assert.equal(downloads.length, 6);
    assert.match(downloads[0].filename, /part-001\.json$/);
    assert.match(downloads.at(-1).filename, /manifest\.json$/);
    const encoded = downloads.at(-1).url.split(',').slice(1).join(',');
    const manifest = JSON.parse(decodeURIComponent(encoded).replace(/^\uFEFF/, ''));
    assert.equal(manifest.parts.length, 5);
    assert.equal(manifest.totalMessages, 5000);
    assert.equal(JSON.stringify(manifest).includes('cursor'), false);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('public job and diagnostics metadata never expose the raw cursor', () => {
  const result = publicJob({
    jobId: 'job', roomId: 'room', format: 'json', state: 'paused',
    nextRequest: { parameter: 'cursor', value: 'secret-cursor' },
    collection: { anchorRequest: { value: 'secret-anchor' } },
    messageCount: 100, pageCount: 1,
  });
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('nanosecond ISO message times retain their precise order', () => {
  const earlier = {
    id: 'MESSAGE-later-id',
    messageTime: '2026-07-20T02:13:01.901662578Z',
  };
  const later = {
    id: 'MESSAGE-earlier-id',
    messageTime: '2026-07-20T02:13:01.901662579Z',
  };
  assert.equal(messageOrderKey(earlier.messageTime), '2026-07-20T02:13:01.901662578Z');
  assert.ok(compareMessageTuples(messageTuple(earlier), messageTuple(later)) < 0);
});

test('the provided message response shape completes as a single page', async () => {
  const store = createMemoryStore();
  let job = await store.createJob({ roomId: 'room-1', format: 'json' });
  const response = {
    messages: [
      {
        id: 'MESSAGE-1', roomId: 'room-1', sender: { type: 'BOT' },
        contents: [{ type: 'TEXT', speakerName: '내레이터', text: '*Test*' }],
        messageTime: '2026-07-13T03:45:59.692093362Z', bookmarkId: 'bookmark-1',
      },
      {
        id: 'MESSAGE-2', roomId: 'room-1', sender: { type: 'USER' },
        contents: [{ type: 'TEXT', speakerName: 'asdf', text: 'room' }],
        messageTime: '2026-07-20T02:13:01.901662578Z', bookmarkId: null,
      },
      {
        id: 'MESSAGE-3', roomId: 'room-1', sender: { type: 'BOT' },
        contents: [{ type: 'TEXT', speakerName: '내레이터', text: 'response' }],
        messageTime: '2026-07-20T02:13:01.911940915Z', bookmarkId: null,
      },
    ],
    nextCursor: null,
    prevCursor: null,
  };
  job = await collectRoomToStore({
    roomId: 'room-1', store, job,
    api: { async getMessagesPage() { return response; } },
  });
  assert.equal(job.state, 'assembling');
  assert.equal(job.messageCount, 3);
  assert.equal(job.pageCount, 1);
});

test('the provided bookmark items shape is parsed with its nested message', async () => {
  const response = {
    items: [{
      bookmark: {
        id: '6f5c332c-fab7-42a9-a5ad-4d88e8962004',
        roomId: 'room-1',
        messageId: 'MESSAGE-1',
        title: '26.07.13 12:45',
        createdAt: '2026-07-13T03:45:59.793121Z',
      },
      message: {
        id: 'MESSAGE-1',
        roomId: 'room-1',
        contents: [{ type: 'TEXT', speakerName: '내레이터', text: '*Test*' }],
        messageTime: '2026-07-13T03:45:59.692093362Z',
      },
    }],
    nextCursor: null,
  };
  const api = createRawTestApi('test-token', {
    delay: async () => {},
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => response }),
  });
  const bookmarks = await api.getBookmarks('room-1');
  assert.equal(bookmarks.length, 1);
  const normalized = normalizeBookmark(bookmarks[0]);
  assert.deepEqual(normalized, {
    id: '6f5c332c-fab7-42a9-a5ad-4d88e8962004',
    roomId: 'room-1',
    messageId: 'MESSAGE-1',
    title: '26.07.13 12:45',
    messageTime: '2026-07-13T03:45:59.692093362Z',
    previewText: '내레이터:*Test*',
  });
});

test('bookmark choices are presented in precise chronological order', async () => {
  const choices = await listRoomBookmarks('room-1', {
    async getBookmarks() {
      return [
        { bookmark: { id: 'later', messageId: '2' }, message: {
          id: '2', messageTime: '2026-07-20T02:13:01.901662579Z',
          contents: [{ speakerName: 'B', text: 'later' }],
        } },
        { bookmark: { id: 'earlier', messageId: '1' }, message: {
          id: '1', messageTime: '2026-07-20T02:13:01.901662578Z',
          contents: [{ speakerName: 'A', text: 'earlier' }],
        } },
      ];
    },
  });
  assert.deepEqual(choices.map((choice) => choice.id), ['earlier', 'later']);
  assert.notEqual(choices[0].dateLabel, '시간 정보 없음');
  assert.match(choices[0].label, new RegExp(`^${choices[0].dateLabel}`));
});

test('a custom bookmark title keeps its message date as separate display data', async () => {
  const [bookmark] = await listRoomBookmarks('room-1', {
    async getBookmarks() {
      return [{
        bookmark: { id: 'custom', messageId: 'MESSAGE-1', title: '중요 장면' },
        message: {
          id: 'MESSAGE-1',
          messageTime: '2026-07-20T02:13:01.901662578Z',
          contents: [{ speakerName: '내레이터', text: 'Test' }],
        },
      }];
    },
  });
  assert.equal(bookmark.title, '중요 장면');
  assert.notEqual(bookmark.dateLabel, '시간 정보 없음');
  assert.match(bookmark.label, /내레이터:Test/);
});

test('low browser storage produces a warning and blocks unsafe page storage', async () => {
  const storageManager = {
    async estimate() {
      return { usage: 95 * 1024 * 1024, quota: 100 * 1024 * 1024 };
    },
  };
  const status = await getStorageStatus(storageManager);
  assert.equal(status.available, 5 * 1024 * 1024);
  assert.match(status.warning, /저장 공간/);
  await assert.rejects(
    assertStorageCapacity(1024, storageManager),
    (error) => error instanceof StorageCapacityError
      && error.code === 'STORAGE_QUOTA_LOW'
      && error.retryable,
  );
});

test('IndexedDB quota errors are converted to a user-facing disk warning', () => {
  const quotaError = new Error('quota');
  quotaError.name = 'QuotaExceededError';
  const normalized = normalizeStorageError(quotaError);
  assert.equal(normalized.code, 'STORAGE_QUOTA_LOW');
  assert.match(normalized.message, /디스크 공간을 확보/);
});

test('one bookmark list selects start, end, and a replacement range in order', () => {
  const ids = ['a', 'b', 'c', 'd'];
  let selection = advanceBookmarkRange({ startId: '', endId: '' }, 'b', ids);
  assert.deepEqual(selection, { startId: 'b', endId: '' });
  selection = advanceBookmarkRange(selection, 'd', ids);
  assert.deepEqual(selection, { startId: 'b', endId: 'd' });
  assert.deepEqual(bookmarkRangeBounds(selection.startId, selection.endId, ids), {
    startIndex: 1, endIndex: 3,
  });
  selection = advanceBookmarkRange(selection, 'c', ids);
  assert.deepEqual(selection, { startId: 'c', endId: '' });
  selection = advanceBookmarkRange(selection, 'a', ids);
  assert.deepEqual(selection, { startId: 'a', endId: '' });
  selection = advanceBookmarkRange(selection, 'a', ids);
  assert.deepEqual(selection, { startId: 'a', endId: 'a' });
});

test('bookmark creation POST includes both roomId and messageId', async () => {
  let captured;
  const api = createRawTestApi('test-token', {
    delay: async () => {},
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 201, json: async () => ({ id: 'bookmark-1' }) };
    },
  });
  await api.createBookmark('room-1', 'MESSAGE-1');
  assert.match(captured.url, /\/v1\/rooms\/room-1\/bookmarks$/);
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(captured.options.body), {
    roomId: 'room-1',
    messageId: 'MESSAGE-1',
  });
});

test('bookmark creation POST is not automatically retried', async () => {
  let calls = 0;
  const rawRequest = createZetaRequest('test-token', {
    delay: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 503 };
    },
  });
  const api = createMessageApi(withZetaReadRetry(rawRequest, { delay: async () => {} }));
  await assert.rejects(api.createBookmark('room-1', 'MESSAGE-1'), /HTTP 503/);
  assert.equal(calls, 1);
});

test('bookmark creation checks duplicates and verifies the created bookmark', async () => {
  let listCalls = 0;
  let createCalls = 0;
  const result = await createRoomBookmark('room-1', 'MESSAGE-1', {
    async getBookmarks() {
      listCalls += 1;
      if (listCalls === 1) {
        return [];
      }
      return [{
        bookmark: { id: 'bookmark-1', roomId: 'room-1', messageId: 'MESSAGE-1' },
        message: {
          id: 'MESSAGE-1', roomId: 'room-1',
          messageTime: '2026-07-20T02:13:01.901662578Z',
          contents: [{ speakerName: 'A', text: 'saved' }],
        },
      }];
    },
    async createBookmark(roomId, messageId) {
      createCalls += 1;
      assert.equal(roomId, 'room-1');
      assert.equal(messageId, 'MESSAGE-1');
      return null;
    },
  });
  assert.equal(result.created, true);
  assert.equal(result.bookmark.id, 'bookmark-1');
  assert.equal(createCalls, 1);
  assert.equal(listCalls, 2);
});

test('right-click message resolution accepts DOM attributes and nearest React props', () => {
  const resolver = globalThis.ZetaMessageContext;
  assert.equal(
    resolver.findMessageId([{ attributes: [{ value: 'MESSAGE-123-Ab_c' }] }]),
    'MESSAGE-123-Ab_c',
  );
  const reactNode = { attributes: [] };
  reactNode.__reactProps$test = { message: { id: 'MESSAGE-456-XyZ' } };
  assert.equal(resolver.findMessageId([reactNode]), 'MESSAGE-456-XyZ');
  assert.equal(resolver.findMessageId([{ attributes: [{ value: 'BOT-123' }] }]), null);
});

test('withRetry decorates an operation without knowing its error policy', async () => {
  let calls = 0;
  const waits = [];
  const events = [];
  const decorated = withRetry(async (value) => {
    calls += 1;
    if (calls < 3) {
      throw new Error(`failure-${calls}`);
    }
    return value * 2;
  }, {
    maxRetries: 2,
    decide: (error, { attempt }) => ({
      retry: true,
      waitMs: 100 * (attempt + 1),
      event: { kind: error.message },
    }),
    delay: async (milliseconds) => { waits.push(milliseconds); },
    onRetry: async (event) => { events.push(event); },
  });

  assert.equal(await decorated(21), 42);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [100, 200]);
  assert.deepEqual(events, [
    { kind: 'failure-1', attempt: 1, waitMs: 100 },
    { kind: 'failure-2', attempt: 2, waitMs: 200 },
  ]);
});
