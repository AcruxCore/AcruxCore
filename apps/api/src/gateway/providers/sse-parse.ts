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
 * @returns An async generator yielding the raw JSON string after each `data:`.
 * @remarks Cancels the underlying reader in `finally`, so if the consumer stops
 *   early the provider HTTP stream is torn down.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
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

  try {
    for (;;) {
      const { done, value } = await reader.read();
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
