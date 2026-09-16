/**
 * Default upstream deadline (ms), shared by every provider adapter.
 *
 * It lives in its own module rather than in `adapter.ts` because `adapter.ts` imports
 * all three concrete adapters, and both `guarded-fetch.ts` and `sse-parse.ts` — which
 * the adapters import — need this value. Taking it from `adapter.ts` would close an
 * import cycle.
 *
 * The value is spent in two places, never as one whole-request clock: `guardedFetch`
 * gives the provider this long to return response headers, and `parseSseStream` gives
 * it this long between consecutive chunks. A generation that streams steadily for ten
 * minutes is healthy and is not cut off.
 */
export const GATEWAY_TIMEOUT_MS = 60_000;
