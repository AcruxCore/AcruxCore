import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../tools/execute/safe-fetch';

const app = createApp();

/** A 1x1 PNG, the same one the issue's reproduction sends. */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Every request the fake upstream received: its path and parsed body. */
let received: Array<{ url: string; body: Record<string, any> }> = [];
let server: http.Server;
let origin: string;

beforeAll(async () => {
  allowLoopbackForTests();
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      received.push({ url: req.url ?? '', body });
      const streamedFailure = body.stream && JSON.stringify(body).includes('unfetchable.png');
      if (!streamedFailure) res.writeHead(200, { 'Content-Type': 'application/json' });
      if (body.stream && JSON.stringify(body).includes('unfetchable.png')) {
        // The streamed form of the same failure: one SSE frame with empty choices and an error.
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ id: 'gen-err', choices: [], error: { message: 'Received 404 status code when fetching image from URL: https://x.test/unfetchable.png', code: 400 } })}\n\n`,
        );
        res.end();
        return;
      }
      if (JSON.stringify(body).includes('unfetchable.png')) {
        // What OpenRouter really sends (captured 2026-10-13) when it cannot download an image
        // link: HTTP 200, an `error` object, and no `choices`.
        res.end(
          JSON.stringify({
            id: 'gen-err',
            error: { message: 'Received 404 status code when fetching image from URL: https://x.test/unfetchable.png', code: 400 },
          }),
        );
      } else if (req.url?.includes(':generateContent')) {
        res.end(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'a red pixel' }], role: 'model' }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            id: 'gen-1',
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'a red pixel' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  // `localhost`, not 127.0.0.1: the connection schema refuses a literal loopback IP.
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  resetSsrfAllowlist();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

beforeEach(() => {
  received = [];
});

/** Signs up a team, connects `provider` to the fake upstream and registers `vision` on it. */
async function arrange(provider: 'openai_compatible' | 'anthropic' | 'gemini', upstreamModel: string) {
  const { agent, teamId } = await authedAgent(app);
  const config =
    provider === 'openai_compatible'
      ? { base_url: `${origin}/v1` }
      : provider === 'gemini'
        ? { base_url: `${origin}/v1beta` }
        : {};
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider, label: provider, apiKey: 'sk-test-000000000000AB12', config })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: 'vision', upstreamModel, credentialId: conn.body.id, inputPricePerM: 1, outputPricePerM: 1 })
    .expect(201);
  return { agent, teamId: teamId as string };
}

const IMAGE_MESSAGE = {
  role: 'user',
  content: [
    { type: 'text', text: 'What is in this image?' },
    { type: 'image_url', image_url: { url: TINY_PNG } },
  ],
};

describe('image input on POST /gateway/chat/completions (issue #567)', () => {
  it('forwards an image_url part to an OpenAI-compatible upstream unchanged, and answers 200', async () => {
    const { agent } = await arrange('openai_compatible', 'google/gemma-4-31b-it');

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'vision', messages: [IMAGE_MESSAGE] })
      .expect(200);

    expect(res.body.choices[0].message.content).toBe('a red pixel');
    expect(received).toHaveLength(1);
    expect(received[0]!.body['messages'][0]).toEqual(IMAGE_MESSAGE);
  });

  it('accepts a remote https image URL and the optional detail field', async () => {
    const { agent } = await arrange('openai_compatible', 'google/gemma-4-31b-it');
    const part = { type: 'image_url', image_url: { url: 'https://example.com/receipt.jpg', detail: 'high' } };

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'vision', messages: [{ role: 'user', content: [part] }] })
      .expect(200);

    expect(received[0]!.body['messages'][0].content).toEqual([part]);
  });

  it('translates the image into an Anthropic base64 source block', async () => {
    // The Anthropic adapter always calls its own host, so this one leg mocks the outbound fetch.
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: 'a red pixel' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    } as unknown as Response);
    try {
      const { agent } = await arrange('anthropic', 'claude-haiku-4-5');
      await agent
        .post('/api/v1/gateway/chat/completions')
        .send({ model: 'vision', messages: [IMAGE_MESSAGE] })
        .expect(200);

      const [, init] = spy.mock.calls[spy.mock.calls.length - 1] as [string, RequestInit];
      expect(JSON.parse(init.body as string).messages[0].content).toEqual([
        { type: 'text', text: 'What is in this image?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG.split(',')[1] } },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('translates the image into a Gemini inlineData part', async () => {
    const { agent } = await arrange('gemini', 'gemini-2.5-flash');

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'vision', messages: [IMAGE_MESSAGE] })
      .expect(200);

    expect(received[0]!.body['contents'][0].parts).toEqual([
      { text: 'What is in this image?' },
      { inlineData: { mimeType: 'image/png', data: TINY_PNG.split(',')[1] } },
    ]);
  });

  it('accepts a body well over the 1 MB default, because a real photo is that large', async () => {
    const { agent } = await arrange('openai_compatible', 'google/gemma-4-31b-it');
    const big = `data:image/jpeg;base64,${'A'.repeat(3 * 1024 * 1024)}`;

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'vision', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: big } }] }] })
      .expect(200);
  });

  it('stores the image in the trace as a placeholder, never as the base64 payload', async () => {
    const { agent, teamId } = await arrange('openai_compatible', 'google/gemma-4-31b-it');

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'vision', messages: [IMAGE_MESSAGE] })
      .expect(200);

    const payload = await prisma.spanPayload.findFirstOrThrow({ where: { teamId } });
    const stored = JSON.stringify(payload.input);
    expect(stored).not.toContain('iVBORw0KGgo');
    expect(stored).toContain('image/png');
    expect(stored).toContain('What is in this image?');
  });

  it.each([
    ['an unknown part type', [{ type: 'audio', data: 'x' }]],
    ['an image part with no url', [{ type: 'image_url', image_url: {} }]],
    ['a non-image data URL', [{ type: 'image_url', image_url: { url: 'data:text/html;base64,PGI+' } }]],
    ['a file: URL', [{ type: 'image_url', image_url: { url: 'file:///etc/passwd' } }]],
    ['an empty parts array', []],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_label, content) => {
    const { agent } = await arrange('openai_compatible', 'google/gemma-4-31b-it');

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'vision', messages: [{ role: 'user', content }] })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(received).toHaveLength(0);
  });

  it('rejects an image part on a system message', async () => {
    const { agent } = await arrange('openai_compatible', 'google/gemma-4-31b-it');

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'vision', messages: [{ ...IMAGE_MESSAGE, role: 'system' }, { role: 'user', content: 'hi' }] })
      .expect(400);

    expect(res.body.error.message).toMatch(/image/i);
  });

  it('turns an upstream 200-with-an-error-body (an image link it could not fetch) into a 400 that says why, not a 500', async () => {
    const { agent } = await arrange('openai_compatible', 'google/gemma-4-31b-it');

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'vision',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x.test/unfetchable.png' } }] }],
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/404 status code when fetching image/);
  });

  it('answers a streamed call with an unfetchable image link as a 400 too, not an empty 200', async () => {
    const { agent } = await arrange('openai_compatible', 'google/gemma-4-31b-it');

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'vision',
        stream: true,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x.test/unfetchable.png' } }] }],
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/404 status code when fetching image/);
  });

  it('answers a clear 400 when a Gemini model is given a remote URL, which it cannot fetch', async () => {
    const { agent } = await arrange('gemini', 'gemini-2.5-flash');

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'vision',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/data:|base64/i);
  });
});
