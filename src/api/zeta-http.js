import { ApiRequestError, HttpStatusError } from './api-errors.js';

const API_ORIGIN = 'https://api.zeta-ai.io';
const REQUEST_INTERVAL_MS = 500;
const CLIENT_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'x-client-type': 'web',
  'x-client-version': '3.41.0',
  'x-client-native-version': '3.41.0',
  'x-device-type': 'pc_web',
  'x-user-language': 'KOREAN',
};

export function createZetaRequest(token, {
  fetchImpl = fetch,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  return async function request(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetchImpl(`${API_ORIGIN}${path}`, {
        method,
        headers: {
          ...CLIENT_HEADERS,
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } finally {
      await delay(REQUEST_INTERVAL_MS);
    }

    if (!response.ok) {
      throw new HttpStatusError(response.status);
    }
    if (response.status === 204) {
      return null;
    }
    try {
      return await response.json();
    }
    catch (error) {
      if (method !== 'GET') {
        return null;
      }
      throw new ApiRequestError('Zeta API 응답을 읽을 수 없습니다.', {
        code: 'INVALID_JSON',
        cause: error,
      });
    }
  };
}
