/**
 * Pauses execution for the given number of milliseconds.
 *
 * @param ms - Duration to sleep in milliseconds.
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps the global `fetch` with retry logic for transient failures.
 *
 * Retries on:
 *   - Network-level errors (fetch() throws)
 *   - HTTP 429 (rate limit)
 *   - HTTP 5xx responses
 *
 * Does NOT retry on HTTP 4xx other than 429 — those are client errors; retrying won't help.
 *
 * Total attempts = 1 + maxRetries (e.g. maxRetries=1 → 2 total attempts).
 *
 * @param url - The URL to fetch.
 * @param init - The RequestInit options to pass to fetch.
 * @param maxRetries - Number of additional attempts after the first failure.
 * @param retryInterval - Fixed delay in ms between retry attempts.
 * @returns The Response from the last successful attempt.
 * @throws The last network error if all attempts fail with a network error.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries: number,
  retryInterval: number,
): Promise<Response> {
  let lastError: unknown;
  const totalAttempts = 1 + maxRetries;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(retryInterval);
    }

    try {
      const response = await fetch(url, init);

      // 429 (rate limit) retries like a 5xx — the gateway used to absorb this via
      // fallback routing across providers; a direct BYO call has no such routing.
      const isRetryableStatus = response.status === 429 || response.status >= 500;

      // Other 4xx: do not retry — return immediately for caller to handle
      if (response.status >= 400 && response.status < 500 && !isRetryableStatus) {
        return response;
      }

      // 429/5xx: retry if we have attempts left
      if (isRetryableStatus) {
        lastError = new Error(`HTTP ${response.status}`);
        if (attempt < totalAttempts - 1) {
          continue;
        }
        // All attempts exhausted — return the last response so caller can inspect body
        return response;
      }

      // 2xx/3xx: success
      return response;
    } catch (err) {
      lastError = err;
      if (attempt < totalAttempts - 1) {
        continue;
      }
      throw err;
    }
  }

  // Unreachable but satisfies TypeScript exhaustiveness
  throw lastError;
}
