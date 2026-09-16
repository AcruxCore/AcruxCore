import { Readable } from 'node:stream';
import { request as undiciRequest, type Agent, type Dispatcher } from 'undici';
import { ProviderError } from './adapter';
import { GATEWAY_TIMEOUT_MS } from './timeout';
import { createSsrfSafeDispatcher, SsrfError } from '../../tools/execute/safe-fetch';
import { capResponseBody } from './response-cap';

/**
 * Copy undici's header bag onto a standard `Headers`.
 *
 * Without this the re-wrapped `Response` carried only a status, so every upstream
 * header was silently lost on the custom-base_url path — including the `Retry-After`
 * that an OpenAI-compatible provider sends with a 429. Dropped headers produce no
 * error, so the loss only showed up as a caller being told to back off by an
 * unspecified amount.
 *
 * undici gives a value as `string | string[] | undefined`; an array is joined the way
 * HTTP folds a repeated header, and an absent value is skipped rather than becoming
 * the literal string `"undefined"`.
 *
 * @param headers - undici's `IncomingHttpHeaders`-shaped bag.
 * @returns The equivalent standard `Headers`.
 */
function toResponseHeaders(headers: Dispatcher.ResponseData['headers']): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return out;
}

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
 * The deadline this arms covers the connection and the response *headers* only, and is
 * cleared the moment they arrive. It cannot cover the body: on a streaming call the caller
 * reads `res.body` long after this function returns, and aborting a fetch signal after
 * headers errors the in-flight body — so a whole-request deadline would cut every stream
 * off mid-answer at {@link GATEWAY_TIMEOUT_MS} and bill the caller for tokens it never
 * received. A stalled body is covered instead by the inter-chunk deadline in
 * `parseSseStream`, and a slow non-streaming body by the caller's own request signal.
 *
 * @param usesCustomBaseUrl - Whether `url` was built from a caller-supplied base URL.
 * @param providerLabel - Human-readable provider name (e.g. `'OpenAI'`, `'Gemini'`), used
 *   only to phrase the SSRF-blocked error message.
 * @param timeoutMs - How long to wait for response headers. Defaults to
 *   {@link GATEWAY_TIMEOUT_MS}; every production call site takes the default, and it is
 *   a parameter so the deadline can be exercised against a real socket in a test without
 *   the test waiting a minute.
 * @param buffersBody - True when the caller will read the whole body into memory, which
 *   caps it at {@link MAX_PROVIDER_RESPONSE_BYTES}. False for a streaming call, whose
 *   chunks are parsed and released as they arrive — so nothing is buffered, and the same
 *   ceiling would instead cut a long answer off part-way: SSE framing costs roughly 170
 *   bytes per token, which puts a 128k-token reply within reach of 25 MB. What should
 *   bound a stream is a separate question, tracked in the FAQ beside this one (#509).
 * @returns The response, plus the pinned dispatcher (if one was created) so the caller can
 *   close it once the response body is fully consumed.
 * @throws {ProviderError} 502 `SSRF_BLOCKED` (non-retriable) if the target resolves to a
 *   disallowed address.
 * @throws {DOMException} `TimeoutError` if no response headers arrive within
 *   {@link GATEWAY_TIMEOUT_MS} (every adapter maps `name === 'TimeoutError'` to a 504).
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
  timeoutMs: number = GATEWAY_TIMEOUT_MS,
  buffersBody: boolean = false,
): Promise<{ res: Response; dispatcher?: Agent }> {
  // A headers deadline, armed here rather than per adapter: the streaming paths
  // forwarded only the caller's signal, so a provider that completed the TCP handshake
  // and then sent nothing held the request, its budget reservation and its rate-limit
  // slot open forever. It is a hand-rolled controller rather than
  // `AbortSignal.timeout(...)` for one reason: this timer must stop the moment the
  // headers land, because the same signal stays attached to the body a streaming caller
  // has not read yet. Combining rather than replacing the caller's signal keeps a client
  // disconnect aborting the body; only the deadline half is disarmed.
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new DOMException(`${providerLabel} sent no response headers in time`, 'TimeoutError'),
      ),
    timeoutMs,
  );
  const signal = init.signal
    ? AbortSignal.any([init.signal, deadline.signal])
    : deadline.signal;
  const guardedInit = { ...init, signal };

  if (!usesCustomBaseUrl) {
    try {
      const plain = await fetch(url, guardedInit);
      return { res: buffersBody ? capResponseBody(plain, providerLabel) : plain };
    } finally {
      clearTimeout(timer);
    }
  }
  let dispatcher: Agent;
  try {
    ({ dispatcher } = await createSsrfSafeDispatcher(url));
  } catch (err) {
    clearTimeout(timer);
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
      signal,
    });
    const res = new Response(
      Readable.toWeb(result.body) as unknown as ConstructorParameters<typeof Response>[0],
      { status: result.statusCode, headers: toResponseHeaders(result.headers) },
    );
    // This is the path that most needs the cap: `usesCustomBaseUrl` means the
    // destination came from the team, the same as a tool executor's URL.
    return { res: buffersBody ? capResponseBody(res, providerLabel) : res, dispatcher };
  } catch (err) {
    // The dispatcher was created but the connection attempt itself failed — close it here
    // so it never leaks, since the caller has no reference to it once we throw.
    await dispatcher.close();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
