import { ApiRequestError, HttpStatusError } from './api-errors.js';
import { withRetry } from '../core/retry.js';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function createZetaRetryPolicy(random = Math.random) {
  return (error, { attempt, maxRetries }) => {
    if (error instanceof ApiRequestError) {
      return { retry: false };
    }
    if (!(error instanceof HttpStatusError)) {
      if (attempt === maxRetries) {
        return {
          retry: false,
          error: new ApiRequestError('Zeta API에 연결할 수 없습니다.', {
            retryable: true,
            cause: error,
            code: 'NETWORK_ERROR',
          }),
        };
      }
      return {
        retry: true,
        waitMs: 1000 * (2 ** attempt),
        event: { kind: 'network' },
      };
    }

    if (error.status === 401) {
      return {
        retry: false,
        error: new ApiRequestError('Zeta 페이지를 새로고침한 뒤 다시 시도해 주세요.', {
          status: 401,
        }),
      };
    }
    if (!RETRYABLE_STATUS.has(error.status)) {
      return {
        retry: false,
        error: new ApiRequestError(`Zeta API 요청에 실패했습니다 (${error.status}).`, {
          status: error.status,
        }),
      };
    }
    if (attempt === maxRetries) {
      return {
        retry: false,
        error: new ApiRequestError(`Zeta API 요청에 반복해서 실패했습니다 (${error.status}).`, {
          status: error.status,
          retryable: true,
        }),
      };
    }
    return {
      retry: true,
      waitMs: error.status === 429
        ? 5000 + Math.floor(random() * 5001)
        : 1000 * (2 ** attempt),
      event: { kind: 'http', status: error.status },
    };
  };
}

export function withZetaReadRetry(request, {
  maxRetries = 4,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random = Math.random,
  onRetry = async () => {},
} = {}) {
  const retryingRequest = withRetry(request, {
    maxRetries,
    decide: createZetaRetryPolicy(random),
    delay,
    onRetry,
  });
  return (path, options = {}) => {
    if (options.method && options.method !== 'GET') {
      return request(path, options);
    }
    return retryingRequest(path, options);
  };
}
