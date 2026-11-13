import { ProviderError } from './adapter';
import { MAX_PROVIDER_RESPONSE_BYTES } from './response-cap';
import { GATEWAY_TIMEOUT_MS } from './timeout';

/**
 * The longest single SSE line the parser will hold, in UTF-16 code units.
 *
 * A streamed body is not wrapped by `capResponseBody`, so without this a provider that
 * never sends a newline grows one pending line for as long as it keeps sending. Set to
 * the buffered-response cap: a frame can carry a whole answer (a base64 image from an
 * image model, a wide `logprobs` block), and one frame is never allowed to be larger than
 * the whole non-streamed answer may be. A UTF-8 byte yields at most one code unit, so
 * this is never stricter than the byte cap it mirrors.
 */
export const MAX_SSE_LINE_CHARS = MAX_PROVIDER_RESPONSE_BYTES;

/**
 * How long to keep reading after `[DONE]` for the body's end. What is left is normally
 * the chunked-encoding terminator, a few bytes that arrive within one round trip. A
 * provider that leaves the body open longer is cut loose, and its socket is dropped.
 * The drain runs after the stream has ended, so this never delays the caller.
 */
export const SSE_DRAIN_TIMEOUT_MS = 1_000;

/** Options for {@link parseSseStream}. */
export interface SseParseOptions {
  /**
   * Whether to read the body to its end after `[DONE]` so its socket can be reused.
   * Defaults to true. Pass false when the caller closes the connection after the call (a
   * per-request dispatcher): the socket is thrown away then, so a drain would only hold
   * that close open, and the body is cancelled at once instead.
   */
  drainAfterDone?: boolean;
}

/**
 * Parse a provider Server-Sent-Events body into the JSON payload of each
 * `data:` line. Buffers across network chunks so a JSON object split over two
 * TCP frames is reassembled. `event:`/`id:`/comment lines are ignored, and the
 * OpenAI `[DONE]` sentinel ends the generator.
 *
 * @param body - The `Response.body` ReadableStream from a streaming fetch.
 * @param signal - Optional abort signal. When it fires, the underlying reader is
 *   cancelled, which tears down the upstream provider stream and resolves the
 *   pending read so the generator completes cleanly (used on client disconnect).
 * @param idleTimeoutMs - Longest gap tolerated *between* chunks before the stream is
 *   treated as dead. This is the streaming half of the gateway deadline: the fetch
 *   signal cannot carry it, because aborting that signal after the headers arrive
 *   errors the body, which would cap every legitimate long generation rather than
 *   only the stalled ones. A gap resets on each chunk, so a slow-but-alive provider
 *   streams for as long as it likes while one that stops sending is cut loose.
 * @param options - See {@link SseParseOptions}.
 * @returns An async generator yielding the raw JSON string after each `data:`. It returns
 *   as soon as it reads `[DONE]`, without waiting for the body to end.
 * @throws {DOMException} `TimeoutError` if no chunk arrives for `idleTimeoutMs`
 *   (every adapter maps `name === 'TimeoutError'` to a 504).
 * @throws {ProviderError} 502 `response_too_large`, not retriable, once one line passes
 *   {@link MAX_SSE_LINE_CHARS}. The reader is cancelled, which drops the provider stream.
 * @remarks At `[DONE]` the generator returns and the rest of the body is read in the
 *   background, for up to {@link SSE_DRAIN_TIMEOUT_MS} or `idleTimeoutMs`, whichever is
 *   shorter. Cancelling a body that has not ended makes undici destroy the socket instead
 *   of returning it to the pool, so every streamed call cost the next call a fresh TCP and
 *   TLS handshake (issue #816). The drain is not awaited, because the gateway records the
 *   call and answers the client only once this generator ends. In every other case (the
 *   consumer stops early, an abort, an error, a stall) the reader is cancelled in
 *   `finally`, which tears down the provider HTTP stream.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleTimeoutMs: number = GATEWAY_TIMEOUT_MS,
  options: SseParseOptions = {},
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // The line read so far whose newline has not arrived yet, and its total length.
  let pending: string[] = [];
  let pendingChars = 0;

  // On abort, cancel the reader: this tears down the provider stream and resolves
  // any pending reader.read() with { done: true }, unblocking the loop cleanly.
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  // Races each read against a fresh timer. `Promise.race` leaves the losing read pending
  // rather than cancelling it, which is why the reader is cancelled explicitly on timeout:
  // that resolves the orphaned read and tears down the provider connection.
  const readWithDeadline = async (ms: number): Promise<{ done: boolean; value?: Uint8Array }> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            void reader.cancel().catch(() => undefined);
            reject(new DOMException('Provider stream stalled', 'TimeoutError'));
          }, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  // True when `finally` must leave the reader alone: the body already ended (naturally, or
  // because an abort cancelled it), or the reader was handed to the background drain.
  let released = false;
  try {
    for (;;) {
      const { done, value } = await readWithDeadline(idleTimeoutMs);
      if (done) {
        released = true;
        break;
      }
      // Only the newly decoded text is searched for a newline. The unfinished line is kept
      // as pieces and joined once, when its newline arrives, so the work stays linear in the
      // bytes received however the provider splits them.
      const text = decoder.decode(value, { stream: true });
      let start = 0;
      let nl: number;
      while ((nl = text.indexOf('\n', start)) !== -1) {
        assertLineFits(pendingChars + (nl - start));
        const raw = pending.length > 0 ? pending.join('') + text.slice(start, nl) : text.slice(start, nl);
        pending = [];
        pendingChars = 0;
        start = nl + 1;
        const line = raw.trim();
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          if (options.drainAfterDone !== false) {
            released = true;
            void drainBody(readWithDeadline, Math.min(SSE_DRAIN_TIMEOUT_MS, idleTimeoutMs));
          }
          return;
        }
        yield data;
      }
      if (start < text.length) {
        pendingChars += text.length - start;
        assertLineFits(pendingChars);
        pending.push(start === 0 ? text : text.slice(start));
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (!released) await reader.cancel().catch(() => undefined);
  }
}

/**
 * Ends the stream when one SSE line has grown past {@link MAX_SSE_LINE_CHARS}.
 *
 * @param chars - The length of the line so far, in UTF-16 code units.
 * @throws {ProviderError} 502 `response_too_large`, not retriable: the same endpoint
 *   would send the same body again.
 */
function assertLineFits(chars: number): void {
  if (chars > MAX_SSE_LINE_CHARS) {
    throw new ProviderError(
      `Provider stream line exceeds the ${MAX_SSE_LINE_CHARS} character limit`,
      502,
      'response_too_large',
      false,
    );
  }
}

/**
 * Reads and discards what is left of the body after `[DONE]`, so undici can reuse the
 * socket. Gives up after `budgetMs` in total: `read` cancels the reader when its deadline
 * passes, which drops the socket. Never rejects, because nothing awaits it.
 *
 * @param read - The parser's deadline-bound read; it cancels the reader on timeout.
 * @param budgetMs - Total time allowed for the body to end.
 */
async function drainBody(read: (ms: number) => Promise<{ done: boolean }>, budgetMs: number): Promise<void> {
  const giveUpAt = Date.now() + budgetMs;
  try {
    for (;;) {
      const left = giveUpAt - Date.now();
      if (left <= 0) {
        // Out of time between two reads: one more read with no time left cancels the reader.
        await read(0);
        return;
      }
      const { done } = await read(left);
      if (done) return;
    }
  } catch {
    // A timeout (the reader is already cancelled) or a read error: the socket is dropped.
  }
}
