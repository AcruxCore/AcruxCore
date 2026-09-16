import { GATEWAY_TIMEOUT_MS } from './timeout';

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
 * @returns An async generator yielding the raw JSON string after each `data:`.
 * @throws {DOMException} `TimeoutError` if no chunk arrives for `idleTimeoutMs`
 *   (every adapter maps `name === 'TimeoutError'` to a 504).
 * @remarks Cancels the underlying reader in `finally`, so if the consumer stops
 *   early the provider HTTP stream is torn down.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleTimeoutMs: number = GATEWAY_TIMEOUT_MS,
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

  // Races each read against a fresh idle timer. `Promise.race` leaves the losing read
  // pending rather than cancelling it, which is why the reader is cancelled explicitly
  // on timeout: that resolves the orphaned read and tears down the provider connection.
  const readWithIdleDeadline = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            void reader.cancel().catch(() => undefined);
            reject(new DOMException('Provider stream stalled', 'TimeoutError'));
          }, idleTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    for (;;) {
      const { done, value } = await readWithIdleDeadline();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        yield data;
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
  }
}
