import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatewayStream } from './gateway';

/**
 * A streamed gateway response, frame by frame, the way the API writes it. Each entry of
 * `pieces` is one network read, so a test can split a frame across two reads.
 */
function sseResponse(pieces: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(encoder.encode(p));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const frame = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

const deltaChunk = (content: string) => ({
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
});

/** The gateway's `stream_options.include_usage` frame: empty `choices`, the billed usage. */
const USAGE_CHUNK = {
  object: 'chat.completion.chunk',
  choices: [],
  usage: { prompt_tokens: 22, completion_tokens: 31, total_tokens: 53 },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gatewayStream token usage (issue #834)', () => {
  it('asks the gateway for usage and hands the final usage chunk to onUsage', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([frame(deltaChunk('Hel')), frame(deltaChunk('lo')), frame(USAGE_CHUNK), frame('[DONE]')]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const deltas: string[] = [];
    const onUsage = vi.fn();

    await gatewayStream({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }, {
      onDelta: (t) => deltas.push(t),
      onUsage,
    });

    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({ prompt: 22, completion: 31 });
  });

  it('keeps any stream_options the caller set', async () => {
    const fetchMock = vi.fn(async () => sseResponse([frame('[DONE]')]));
    vi.stubGlobal('fetch', fetchMock);

    await gatewayStream(
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        stream_options: { include_usage: true, include_obfuscation: false } as never,
      },
      { onDelta: () => {} },
    );

    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.stream_options).toEqual({ include_usage: true, include_obfuscation: false });
  });

  it('reads a usage chunk split across two network reads, and emits no blank delta for it', async () => {
    const usage = frame(USAGE_CHUNK);
    const half = Math.floor(usage.length / 2);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([frame(deltaChunk('ok')), usage.slice(0, half), usage.slice(half), frame('[DONE]')])),
    );
    const onDelta = vi.fn();
    const onUsage = vi.fn();

    await gatewayStream({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }, { onDelta, onUsage });

    expect(onDelta.mock.calls).toEqual([['ok']]);
    expect(onUsage).toHaveBeenCalledWith({ prompt: 22, completion: 31 });
  });

  it('does not call onUsage when the stream carries no usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([frame(deltaChunk('ok')), frame('[DONE]')])));
    const onUsage = vi.fn();

    await gatewayStream({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }, {
      onDelta: () => {},
      onUsage,
    });

    expect(onUsage).not.toHaveBeenCalled();
  });
});
