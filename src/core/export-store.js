import { messageOrderKey } from './message-order.js';
import { assertStorageCapacity, normalizeStorageError } from './storage-capacity.js';

const DATABASE_NAME = 'zeta-room-exporter';
const DATABASE_VERSION = 3;
const JOBS_STORE = 'jobs';
const MESSAGES_STORE = 'messages';
const MAX_DIAGNOSTICS = 100;

let databasePromise;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', resolve, { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
    transaction.addEventListener('error', () => reject(transaction.error), { once: true });
  });
}

function openDatabase() {
  if (databasePromise) {
    return databasePromise;
  }
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener('upgradeneeded', (event) => {
      const database = request.result;
      const jobs = !database.objectStoreNames.contains(JOBS_STORE)
        ? database.createObjectStore(JOBS_STORE, { keyPath: 'jobId' })
        : request.transaction.objectStore(JOBS_STORE);

      if (!jobs.indexNames.contains('byRoomAndUpdatedAt')) {
        jobs.createIndex('byRoomAndUpdatedAt', ['roomId', 'updatedAt']);
      }

      const messages = !database.objectStoreNames.contains(MESSAGES_STORE)
        ? database.createObjectStore(MESSAGES_STORE, {
          keyPath: ['jobId', 'messageId'],
        }) : request.transaction.objectStore(MESSAGES_STORE);

      if (!messages.indexNames.contains('byJob')) {
        messages.createIndex('byJob', 'jobId');
      }

      if (!messages.indexNames.contains('byJobAndOrder')) {
        messages.createIndex('byJobAndOrder', ['jobId', 'sortTime', 'messageId']);
      }

      if (!messages.indexNames.contains('byJobAndSort')) {
        messages.createIndex('byJobAndSort', ['jobId', 'sortKey', 'messageId']);
      }

      if (event.oldVersion > 0 && event.oldVersion < 3) {
        const cursorRequest = messages.openCursor();
        cursorRequest.addEventListener('success', () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            return;
          }
          const record = cursor.value;
          record.sortKey = messageOrderKey(record.message?.messageTime) || '';
          cursor.update(record);
          cursor.continue();
        });
      }

    });
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => {
      databasePromise = undefined;
      reject(request.error);
    }, { once: true });
  });
  return databasePromise;
}

function createJobId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function publicJob(job) {
  if (!job) {
    return undefined;
  }
  return {
    jobId: job.jobId,
    roomId: job.roomId,
    format: job.format,
    rangeType: job.range?.type || 'all',
    state: job.state,
    messageCount: job.messageCount || 0,
    pageCount: job.pageCount || 0,
    estimatedBytes: job.estimatedBytes || 0,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastSuccessAt: job.lastSuccessAt,
    lastError: job.lastError,
  };
}

async function mutateJob(jobId, mutate) {
  const database = await openDatabase();
  const transaction = database.transaction(JOBS_STORE, 'readwrite');
  const jobs = transaction.objectStore(JOBS_STORE);
  const job = await requestResult(jobs.get(jobId));
  if (!job) {
    transaction.abort();
    throw new Error('내보내기 작업을 찾을 수 없습니다.');
  }
  const updatedJob = mutate(job);
  jobs.put(updatedJob);
  await transactionDone(transaction);
  return updatedJob;
}

export function createExportStore() {
  return {
    async createJob({ roomId, format, range = { type: 'all' }, collection = {} }) {
      const database = await openDatabase();
      const now = Date.now();
      const job = {
        jobId: createJobId(),
        roomId,
        format,
        range,
        collection,
        state: 'collecting',
        nextRequest: collection.nextRequest ?? null,
        messageCount: 0,
        pageCount: 0,
        estimatedBytes: 0,
        diagnostics: [],
        createdAt: now,
        updatedAt: now,
        lastSuccessAt: null,
        lastError: null,
      };
      const transaction = database.transaction(JOBS_STORE, 'readwrite');
      transaction.objectStore(JOBS_STORE).add(job);
      await transactionDone(transaction);
      return job;
    },

    async getJob(jobId) {
      const database = await openDatabase();
      const transaction = database.transaction(JOBS_STORE, 'readonly');
      return requestResult(transaction.objectStore(JOBS_STORE).get(jobId));
    },

    async getPublicJob(jobId) {
      return publicJob(await this.getJob(jobId));
    },

    async findLatestJob({ roomId, states } = {}) {
      const database = await openDatabase();
      const transaction = database.transaction(JOBS_STORE, 'readonly');
      const index = transaction.objectStore(JOBS_STORE).index('byRoomAndUpdatedAt');
      const keyRange = IDBKeyRange.bound([roomId, 0], [roomId, Number.MAX_SAFE_INTEGER]);
      const request = index.openCursor(keyRange, 'prev');
      return new Promise((resolve, reject) => {
        request.addEventListener('success', () => {
          const cursor = request.result;
          if (!cursor) {
            return resolve(undefined);
          }
          if (!states || states.includes(cursor.value.state)) {
            return resolve(cursor.value);
          }
          cursor.continue();
        });
        request.addEventListener('error', () => reject(request.error), { once: true });
      });
    },

    async findLatestPublicJob(options) {
      return publicJob(await this.findLatestJob(options));
    },

    async savePage(jobId, messages, {
      nextRequest = null,
      finished = false,
      checkpoint = {},
    } = {}) {
      const preparedMessages = [];
      let pageBytes = 0;
      for (const message of messages) {
        if (message?.id === undefined || message?.id === null) {
          throw new Error('ID가 없는 메시지는 저장할 수 없습니다.');
        }
        const serialized = JSON.stringify(message);
        pageBytes += new Blob([serialized]).size;
        preparedMessages.push({
          messageId: String(message.id),
          sortKey: messageOrderKey(message.messageTime) || '',
          message,
        });
      }
      await assertStorageCapacity(pageBytes);

      const database = await openDatabase();
      const transaction = database.transaction([JOBS_STORE, MESSAGES_STORE], 'readwrite');
      const jobs = transaction.objectStore(JOBS_STORE);
      const storedMessages = transaction.objectStore(MESSAGES_STORE);
      const job = await requestResult(jobs.get(jobId));
      if (!job) {
        transaction.abort();
        throw new Error('내보내기 작업을 찾을 수 없습니다.');
      }

      for (const prepared of preparedMessages) {
        storedMessages.put({
          jobId,
          ...prepared,
        });
      }

      const messageCount = await requestResult(storedMessages.index('byJob').count(jobId));
      const now = Date.now();
      const updatedJob = {
        ...job,
        collection: { ...job.collection, ...checkpoint },
        state: finished ? 'assembling' : 'collecting',
        nextRequest,
        messageCount,
        pageCount: job.pageCount + 1,
        estimatedBytes: (job.estimatedBytes || 0) + pageBytes,
        updatedAt: now,
        lastSuccessAt: now,
        lastError: null,
      };
      jobs.put(updatedJob);
      try {
        await transactionDone(transaction);
      } catch (error) {
        throw normalizeStorageError(error);
      }
      return updatedJob;
    },

    async setState(jobId, state) {
      return mutateJob(jobId, (job) => ({ ...job, state, updatedAt: Date.now() }));
    },

    async configureCollection(jobId, collection) {
      return mutateJob(jobId, (job) => ({
        ...job,
        collection: { ...job.collection, ...collection },
        nextRequest: collection.nextRequest ?? job.nextRequest,
        updatedAt: Date.now(),
      }));
    },

    async pauseJob(jobId, error) {
      return mutateJob(jobId, (job) => ({
        ...job,
        state: 'paused',
        updatedAt: Date.now(),
        lastError: {
          code: error?.status || error?.code || 'NETWORK_ERROR',
          retryable: true,
          occurredAt: Date.now(),
        },
      }));
    },

    async failJob(jobId, error) {
      return mutateJob(jobId, (job) => ({
        ...job,
        state: 'failed',
        updatedAt: Date.now(),
        lastError: {
          code: error?.status || error?.code || 'INVALID_RESPONSE',
          retryable: false,
          occurredAt: Date.now(),
        },
      }));
    },

    async addDiagnostic(jobId, event) {
      return mutateJob(jobId, (job) => ({
        ...job,
        diagnostics: [...(job.diagnostics || []), {
          status: event.status || null,
          attempt: event.attempt,
          waitMs: event.waitMs,
          kind: event.kind,
          occurredAt: Date.now(),
        }].slice(-MAX_DIAGNOSTICS),
        updatedAt: Date.now(),
      }));
    },

    async readMessages(jobId, { afterKey, limit = 250 } = {}) {
      const database = await openDatabase();
      const transaction = database.transaction(MESSAGES_STORE, 'readonly');
      const index = transaction.objectStore(MESSAGES_STORE).index('byJobAndSort');
      const lower = afterKey || [jobId, '', ''];
      const upper = [jobId, '\uffff', '\uffff'];
      const range = IDBKeyRange.bound(lower, upper, Boolean(afterKey), false);
      const request = index.openCursor(range);
      return new Promise((resolve, reject) => {
        const records = [];
        request.addEventListener('success', () => {
          const cursor = request.result;
          if (!cursor || records.length >= limit) {
            resolve({
              messages: records.map((record) => record.message),
              nextKey: records.length === limit ? records.at(-1).key : null,
            });
            return;
          }
          records.push({ key: cursor.key, message: cursor.value.message });
          cursor.continue();
        });
        request.addEventListener('error', () => reject(request.error), { once: true });
      });
    },

    async getDiagnosticLog(jobId) {
      const job = await this.getJob(jobId);
      if (!job) {
        throw new Error('내보내기 작업을 찾을 수 없습니다.');
      }
      return {
        version: 1,
        job: publicJob(job),
        events: job.diagnostics || [],
      };
    },

    async deleteJob(jobId) {
      const database = await openDatabase();
      const transaction = database.transaction([JOBS_STORE, MESSAGES_STORE], 'readwrite');
      transaction.objectStore(JOBS_STORE).delete(jobId);
      const messages = transaction.objectStore(MESSAGES_STORE);
      const request = messages.index('byJob').openKeyCursor(IDBKeyRange.only(jobId));
      request.addEventListener('success', () => {
        const cursor = request.result;
        if (!cursor) {
          return;
        }
        messages.delete(cursor.primaryKey);
        cursor.continue();
      });
      await transactionDone(transaction);
    },
  };
}

export { publicJob };
