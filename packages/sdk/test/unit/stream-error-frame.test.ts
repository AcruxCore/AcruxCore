import { describe, it, expect, vi, afterEach } from 'vitest';
import { acruxcore } from '../../src/client';
import { acruxcoreError } from '../../src/error';

/** Builds a Response whose body streams the given SSE frames. */
function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const chunk = (text: string): string =>
  `data: ${JSON.stringify({
    id: 'cmpl-1',
    model: 'gpt-4o-mini',
    choices: [{ delta: { content: text }, finish_reason: null }],
  })}\n\n`;

describe('streamChat — a mid-stream error frame', () => {
  afterEach(() => vi.restoreAllMocks());

  it('raises a typed error instead of failing on the missing choices array', async () => {
    // What the gateway now sends when the call fails after the first byte has gone
    // out. Before this, `parsed.choices[0]` threw a bare TypeError with no code and
    // no message, which reads to a caller as a bug in the SDK.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        chunk('Hel'),
        `data: ${JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Budget not found.' } })}\n\n`,
        'data: [DONE]\n\n',
      ]),
    );

    const client = new acruxcore({ apiKey: 'acx_sk_test', baseUrl: 'http://localhost:3000' });
    const received: string[] = [];

    await expect(
      (async () => {
        const stream = await client.gateway.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true });
        for await (const c of stream) {
          if (c.delta?.content) received.push(c.delta.content);
        }
      })(),
    ).rejects.toBeInstanceOf(acruxcoreError);

    // The text delivered before the failure is still handed to the caller.
    expect(received).toEqual(['Hel']);
  });

  it('carries the gateway’s own message and code on the thrown error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        `data: ${JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Budget not found.' } })}\n\n`,
        'data: [DONE]\n\n',
      ]),
    );

    const client = new acruxcore({ apiKey: 'acx_sk_test', baseUrl: 'http://localhost:3000' });
    try {
      const stream = await client.gateway.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true });
      for await (const _ of stream) {
        // consume
      }
      throw new Error('expected the stream to raise');
    } catch (err) {
      expect(err).toBeInstanceOf(acruxcoreError);
      const e = err as acruxcoreError;
      expect(e.code).toBe('API_ERROR');
      expect(e.message).toContain('Budget not found.');
      expect((e.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    }
  });

  it('still completes normally on a clean stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([chunk('Hello'), chunk(' there'), 'data: [DONE]\n\n']),
    );

    const client = new acruxcore({ apiKey: 'acx_sk_test', baseUrl: 'http://localhost:3000' });
    const received: string[] = [];
    const stream = await client.gateway.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true });
    for await (const c of stream) {
      if (c.delta?.content) received.push(c.delta.content);
    }
    expect(received.join('')).toBe('Hello there');
  });
});
