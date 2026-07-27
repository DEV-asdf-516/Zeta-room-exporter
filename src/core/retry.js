export function withRetry(operation, {
  maxRetries = 0,
  decide,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  onRetry = async () => { },
} = {}) {
  if (typeof operation !== 'function') {
    throw new TypeError('operation must be a function');
  }
  if (typeof decide !== 'function') {
    throw new TypeError('decide must be a function');
  }

  return async function retryingOperation(...args) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await operation(...args);
      } catch (caughtError) {
        const decision = decide(caughtError, { attempt, maxRetries });
        const error = decision?.error || caughtError;
        if (!decision?.retry) {
          throw error;
        }
        const event = {
          ...decision.event,
          attempt: attempt + 1,
          waitMs: decision.waitMs,
        };
        await onRetry(event);
        await delay(decision.waitMs);
      }
    }
    throw new Error('Retry loop ended unexpectedly.');
  };
}
