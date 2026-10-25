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

/**
 * Ceiling (ms) on one whole gateway call before it answers: every deployment in the
 * fallback chain and every retry share it, and the attempt still running when it
 * passes is cut off as a timeout.
 *
 * Without it the chain had no end of its own — each attempt could take
 * {@link GATEWAY_TIMEOUT_MS}, so a primary and a backup that both hang ran past
 * Cloudflare's 100 s origin limit, and the caller got Cloudflare's HTML 524 page
 * instead of our JSON error and its traceId (issue #732). 90 s leaves room under
 * that limit for the work before and after the provider calls. The `/api/` block
 * in `apps/web/nginx.conf` waits 120 s, above this, so nginx never answers first.
 */
export const GATEWAY_CHAIN_DEADLINE_MS = 90_000;

/**
 * The chain deadline in force: `GATEWAY_CHAIN_DEADLINE_MS` from the environment
 * when it is a positive number, else {@link GATEWAY_CHAIN_DEADLINE_MS}.
 *
 * Read on every call rather than once, so a test can shorten it. A self-hosted
 * install behind a proxy that waits less than 90 s (an AWS load balancer's 60 s
 * idle timeout, for example) lowers it below that proxy's limit; raising it past
 * the 120 s the bundled nginx waits brings back nginx's HTML 504.
 *
 * @returns The deadline in milliseconds.
 */
export function gatewayChainDeadlineMs(): number {
  const fromEnv = Number(process.env.GATEWAY_CHAIN_DEADLINE_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : GATEWAY_CHAIN_DEADLINE_MS;
}

/**
 * The signal one non-streaming provider call runs under: its own
 * {@link GATEWAY_TIMEOUT_MS}, cut shorter by `deadline` when the caller has less
 * time left than that (the fallback chain passes what remains of
 * {@link GATEWAY_CHAIN_DEADLINE_MS}). Either clock aborts with a `TimeoutError`,
 * which every adapter already maps to a timeout.
 *
 * @param deadline - Optional caller deadline; omitted, only the per-call clock applies.
 * @returns A signal that aborts when the first of the two clocks runs out.
 */
export function providerCallSignal(deadline?: AbortSignal): AbortSignal {
  const own = AbortSignal.timeout(GATEWAY_TIMEOUT_MS);
  return deadline ? AbortSignal.any([own, deadline]) : own;
}
