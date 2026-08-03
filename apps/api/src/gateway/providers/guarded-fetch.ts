import { Readable } from 'node:stream';
import { request as undiciRequest, type Agent, type Dispatcher } from 'undici';
import { ProviderError } from './adapter';
import { createSsrfSafeDispatcher, SsrfError } from '../../tools/execute/safe-fetch';

/**
 * Performs the upstream provider fetch, routing a caller-supplied base URL through the
 * SSRF-safe dispatcher while leaving the hardcoded default base URL on plain global
 * `fetch`. Shared by every HTTP-calling provider adapter (`openai.adapter.ts`,
 * `gemini.adapter.ts`, …) so the SSRF-safety and cleanup behavior lives in exactly one
 * place instead of being forked per adapter.
 *
 * A caller-supplied `creds.baseUrl` is untrusted (it came from a connection's `config`,
 * which the Zod schema only rejects when it is a *literal* blocked IP — a hostname
 * resolving to an internal address at request time is still possible), so that path is
 * routed through {@link createSsrfSafeDispatcher}'s DNS-resolve-then-pin guard, using
 * undici's low-level `request()` (not its `fetch()` wrapper, whose abort-listener cleanup
 * throws under Jest — the same incompatibility documented on `safeFetch`) and re-wrapping
 * the result as a standard `Response` so callers can keep using
 * `res.ok`/`res.status`/`res.json()`/`res.body` unchanged. The hardcoded default base URL
 * needs no such guard and keeps using global `fetch` directly.
 *
 * If the dispatcher is created successfully but the subsequent `undiciRequest` call then
 * fails (host down, TLS failure, timeout — reachable any time the SSRF DNS check passes
 * but the real connection attempt then fails), the dispatcher is closed right here before
 * the error is rethrown. This matters because the caller only receives `dispatcher` in the
 * function's *return value* — on a thrown error there is no return value, so a caller-side
 * `finally { dispatcher?.close() }` can never run. Without this internal cleanup, every such
 * failure would leak the already-created `Agent` (and its socket).
 *
 * @param url - The absolute request URL.
 * @param init - Method/headers/body/signal, same shape as `RequestInit`.
 * @param usesCustomBaseUrl - Whether `url` was built from a caller-supplied base URL.
 * @param providerLabel - Human-readable provider name (e.g. `'OpenAI'`, `'Gemini'`), used
 *   only to phrase the SSRF-blocked error message.
 * @returns The response, plus the pinned dispatcher (if one was created) so the caller can
 *   close it once the response body is fully consumed.
 * @throws {ProviderError} 502 `SSRF_BLOCKED` (non-retriable) if the target resolves to a
 *   disallowed address.
 * @throws {Error} The raw error from `undiciRequest` on any other connection failure
 *   (timeout, DNS, TLS, ECONNREFUSED, …) — callers must normalize this into a
 *   `ProviderError` themselves (both `chatCompletion` and `streamChatCompletion` in every
 *   adapter wrap their `guardedFetch` call in a try/catch that does exactly that).
 */
export async function guardedFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
  usesCustomBaseUrl: boolean,
  providerLabel: string,
): Promise<{ res: Response; dispatcher?: Agent }> {
  if (!usesCustomBaseUrl) {
    return { res: await fetch(url, init) };
  }
  let dispatcher: Agent;
  try {
    ({ dispatcher } = await createSsrfSafeDispatcher(url));
  } catch (err) {
    if (err instanceof SsrfError) {
      throw new ProviderError(
        `${providerLabel} request blocked: target address is not allowed`,
        502,
        'SSRF_BLOCKED',
        false,
      );
    }
    throw err;
  }
  try {
    const result = await undiciRequest(url, {
      method: init.method as Dispatcher.HttpMethod,
      headers: init.headers,
      body: init.body,
      dispatcher,
      signal: init.signal,
    });
    const res = new Response(
      Readable.toWeb(result.body) as unknown as ConstructorParameters<typeof Response>[0],
      { status: result.statusCode },
    );
    return { res, dispatcher };
  } catch (err) {
    // The dispatcher was created but the connection attempt itself failed — close it here
    // so it never leaks, since the caller has no reference to it once we throw.
    await dispatcher.close();
    throw err;
  }
}
