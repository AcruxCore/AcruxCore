import { ProviderError } from './adapter';
import { MAX_SSE_LINE_CHARS, parseSseStream } from './sse-parse';

const CHUNK = 64 * 1024;

/**
 * A body served from memory in `chunkSize` pieces, the way undici hands a provider stream
 * over. `pull` makes each piece on demand, so a test can describe a body far larger than
 * anything it would want to hold at once.
 */
function bodyOf(parts: Array<{ text: string; repeat?: number }>, chunkSize = CHUNK): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const queue = parts.flatMap(({ text, repeat = 1 }) => Array.from({ length: repeat }, () => text));
  let i = 0;
  // The part being served and how far into it the last chunk reached. Sliced by offset, so
  // the helper itself stays linear and does not dominate the timings below.
  let current = new Uint8Array(0);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const out = new Uint8Array(chunkSize);
      let filled = 0;
      while (filled < chunkSize) {
        if (offset === current.length) {
          if (i === queue.length) break;
          current = encoder.encode(queue[i++]!);
          offset = 0;
        }
        const take = Math.min(chunkSize - filled, current.length - offset);
        out.set(current.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
      }
      if (filled === 0) controller.close();
      else controller.enqueue(out.slice(0, filled));
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const frames: string[] = [];
  for await (const data of parseSseStream(body, undefined, 5_000, { drainAfterDone: false })) frames.push(data);
  return frames;
}

describe('parseSseStream — a line with no end is bounded', () => {
  it('fails a newline-free body past the line limit with a non-retriable response_too_large', async () => {
    // One valid frame, then 32 MiB with no newline: a custom base_url can send this.
    const body = bodyOf([
      { text: 'data: {"n":1}\n\n' },
      { text: 'a'.repeat(CHUNK), repeat: (32 * 1024 * 1024) / CHUNK },
    ]);
    const started = Date.now();
    const frames: string[] = [];
    let caught: unknown;
    try {
      for await (const data of parseSseStream(body, undefined, 5_000)) frames.push(data);
    } catch (err) {
      caught = err;
    }
    const tookMs = Date.now() - started;

    expect(frames).toEqual(['{"n":1}']);
    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught).toMatchObject({ status: 502, providerCode: 'response_too_large', retriable: false });
    // The quadratic parser needed several seconds to reach this size; the linear one
    // stops at the limit in tens of milliseconds. A generous bound keeps CI from flaking.
    expect(tookMs).toBeLessThan(1_500);
  });

  it('parses a long line delivered in small chunks in linear time', async () => {
    // An 8 MiB frame in 4 KiB pieces: re-scanning the whole pending line on every piece
    // is ~2,000 passes over up to 8 MiB each, several seconds; one pass is milliseconds.
    const big = 'x'.repeat(8 * 1024 * 1024);
    const body = bodyOf([{ text: `data: "${big}"\n\ndata: {"n":2}\n\ndata: [DONE]\n\n` }], 4 * 1024);
    const started = Date.now();
    const frames = await collect(body);
    const tookMs = Date.now() - started;

    expect(frames).toHaveLength(2);
    expect(frames[0]).toHaveLength(big.length + 2);
    expect(frames[1]).toBe('{"n":2}');
    expect(tookMs).toBeLessThan(1_000);
  });

  it('still reassembles frames split across chunks, with CRLF line ends and comments', async () => {
    const text = ': keep-alive\r\nevent: x\r\ndata: {"a":"b"}\r\n\r\ndata:{"c":1}\n\ndata: [DONE]\n\ndata: {"never":1}\n\n';
    const frames = await collect(bodyOf([{ text }], 3));
    expect(frames).toEqual(['{"a":"b"}', '{"c":1}']);
  });

  it('keeps a multi-byte character split across two chunks intact', async () => {
    const frames = await collect(bodyOf([{ text: 'data: {"t":"héllo — ✓"}\n\ndata: [DONE]\n\n' }], 1));
    expect(frames).toEqual(['{"t":"héllo — ✓"}']);
  });

  it('accepts a line exactly at the limit', async () => {
    const payload = 'y'.repeat(MAX_SSE_LINE_CHARS - 'data: '.length);
    const frames = await collect(bodyOf([{ text: `data: ${payload}\ndata: [DONE]\n` }]));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(payload.length);
  });
});
