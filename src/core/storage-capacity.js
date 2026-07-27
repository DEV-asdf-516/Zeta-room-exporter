const WARNING_FREE_BYTES = 100 * 1024 * 1024;
const REQUIRED_HEADROOM_BYTES = 8 * 1024 * 1024;

export class StorageCapacityError extends Error {
  constructor(availableBytes = 0, cause) {
    const availableMiB = Math.max(0, Math.floor(availableBytes / (1024 * 1024)));
    super(`브라우저 저장 공간이 부족합니다 (약 ${availableMiB} MiB 남음). 디스크 공간을 확보하거나 저장된 작업을 삭제한 뒤 다시 시도해 주세요.`, { cause });
    this.name = 'StorageCapacityError';
    this.code = 'STORAGE_QUOTA_LOW';
    this.retryable = true;
    this.availableBytes = availableBytes;
  }
}

export async function getStorageStatus(storageManager = globalThis.navigator?.storage) {
  if (!storageManager?.estimate) {
    return { supported: false, usage: null, quota: null, available: null, warning: null };
  }
  let estimate;
  try {
    estimate = await storageManager.estimate();
  } catch {
    return { supported: false, usage: null, quota: null, available: null, warning: null };
  }
  const usage = Number.isFinite(estimate.usage) ? estimate.usage : 0;
  const quota = Number.isFinite(estimate.quota) ? estimate.quota : null;
  const available = quota === null ? null : Math.max(0, quota - usage);
  return {
    supported: true,
    usage,
    quota,
    available,
    warning: available !== null && available < WARNING_FREE_BYTES
      ? `브라우저 저장 공간이 얼마 남지 않았습니다 (약 ${Math.floor(available / (1024 * 1024))} MiB). 긴 대화는 공간 부족으로 중단될 수 있습니다.`
      : null,
  };
}

export async function assertStorageCapacity(additionalBytes = 0, storageManager) {
  const status = await getStorageStatus(storageManager);
  if (status.available !== null
    && status.available < additionalBytes + REQUIRED_HEADROOM_BYTES) {
    throw new StorageCapacityError(status.available);
  }
  return status;
}

export function normalizeStorageError(error) {
  if (error instanceof StorageCapacityError) {
    return error;
  }
  if (error?.name === 'QuotaExceededError' || error?.code === 22) {
    return new StorageCapacityError(0, error);
  }
  return error;
}

export const storageCapacityLimits = { WARNING_FREE_BYTES, REQUIRED_HEADROOM_BYTES };
