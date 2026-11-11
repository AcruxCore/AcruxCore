import { GATEWAY_TIMEOUT_MS } from './timeout';

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
  let buffer = '';

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
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
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
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (!released) await reader.cancel().catch(() => undefined);
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
