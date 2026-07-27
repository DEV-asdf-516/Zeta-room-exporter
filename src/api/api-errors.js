export class HttpStatusError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

export class ApiRequestError extends Error {
  constructor(message, { status, retryable = false, cause, code } = {}) {
    super(message, { cause });
    this.name = 'ApiRequestError';
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}
