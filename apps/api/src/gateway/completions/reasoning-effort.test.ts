import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../tools/execute/safe-fetch';

const app = createApp();

/**
 * Usage z.ai returned for `glm-5.3` with `reasoning_effort: "low"` (captured 16 Oct 2026,
 * issue #593): `reasoning_tokens` is a subset of `completion_tokens`.
 */
const OPENAI_USAGE = {
  prompt_tokens: 20,
  completion_tokens: 17,
  total_tokens: 37,
  completion_tokens_details: { reasoning_tokens: 9 },
};

/** Gemini's native usage block; `thoughtsTokenCount` is its reasoning count. */
const GEMINI_USAGE = { promptTokenCount: 20, candidatesTokenCount: 8, thoughtsTokenCount: 9, totalTokenCount: 37 };

/** Every request body the fake upstream received, newest last. */
let received: Array<Record<string, unknown>> = [];
let server: http.Server;
let origin: string;

beforeAll(async () => {
  allowLoopbackForTests();
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      received.push(body);
      // A primary that is down, and a non-reasoning fallback that refuses the field, with
      // the error body OpenAI returns for gpt-4o.
      if (body.model === 'gpt-5-down') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'The server is overloaded.' } }));
        return;
      }
      // z.ai's real answer to a value it does not know (captured 16 Oct 2026).
      if (body.reasoning_effort === 'extreme') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { code: '1210', message: 'reasoning_effort must be one of: none, minimal, low, medium, high, xhigh, max' },
          }),
        );
        return;
      }
      if (body.max_tokens === 5) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'max_tokens must be at least 16.' } }));
        return;
      }
      if (body.model === 'gpt-4o' && 'reasoning_effort' in body) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.",
              type: 'invalid_request_error',
              param: 'reasoning_effort',
              code: 'unsupported_parameter',
            },
          }),
        );
        return;
      }
      if (req.url?.includes(':generateContent')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'no' }] }, finishReason: 'STOP' }],
            usageMetadata: GEMINI_USAGE,
          }),
        );
        return;
      }
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'no' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: OPENAI_USAGE })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'gen-1',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'no' }, finish_reason: 'stop' }],
          usage: OPENAI_USAGE,
        }),
      );
    });
  });
  // `localhost`, not 127.0.0.1: the connection schema refuses a literal loopback IP.
  await new Promise<void>((resolve) => server.listen(0, resolve));
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

/** Signs up a team with one connection of `provider` pointed at the fake upstream, and a `glm` model on it. */
async function arrange(provider: 'openai_compatible' | 'gemini') {
  const { agent } = await authedAgent(app);
  const base = provider === 'gemini' ? `${origin}/v1beta` : `${origin}/v1`;
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider, label: provider, apiKey: 'sk-zai-00000000000AB12', config: { base_url: base } })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: 'glm', upstreamModel: 'glm-5.3', credentialId: conn.body.id, inputPricePerM: 1, outputPricePerM: 1 })
    .expect(201);
  return agent;
}

const ASK = { model: 'glm', messages: [{ role: 'user', content: 'Is 1001 a prime number?' }] };

describe('reasoning_effort and reasoning tokens through the gateway (issue #593)', () => {
  it('forwards reasoning_effort upstream and returns usage.reasoning_tokens', async () => {
    const agent = await arrange('openai_compatible');

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ ...ASK, reasoning_effort: 'low' })
      .expect(200);

    expect(received).toHaveLength(1);
    expect(received[0]!.reasoning_effort).toBe('low');
    expect(res.body.usage).toEqual({
      prompt_tokens: 20,
      completion_tokens: 17,
      total_tokens: 37,
      reasoning_tokens: 9,
      completion_tokens_details: { reasoning_tokens: 9 },
    });
    expect(res.headers['x-gateway-params-ignored']).toBeUndefined();

    // The traced llm span keeps the reasoning count with the rest of the usage.
    const span = await prisma.span.findFirstOrThrow({
      where: { traceId: res.headers['x-gateway-trace-id'] },
      include: { payload: true },
    });
    expect((span.payload?.output as { usage?: unknown } | null)?.usage).toMatchObject({ reasoning_tokens: 9 });
  });

  it('forwards reasoning_effort on a streamed call', async () => {
    const agent = await arrange('openai_compatible');

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ ...ASK, stream: true, reasoning_effort: 'high' })
      .expect(200);

    expect(received).toHaveLength(1);
    expect(received[0]!.reasoning_effort).toBe('high');
  });

  it('caches two calls that differ only in reasoning_effort under different keys', async () => {
    const { agent } = await authedAgent(app);
    const conn = await agent
      .post('/api/v1/gateway/connections')
      .send({ provider: 'openai_compatible', label: 'zai', apiKey: 'sk-zai-00000000000AB12', config: { base_url: `${origin}/v1` } })
      .expect(201);
    await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'glm', upstreamModel: 'glm-5.3', credentialId: conn.body.id, inputPricePerM: 1, outputPricePerM: 1 })
      .expect(201);
    const key = await agent
      .post('/api/v1/gateway/keys')
      .send({ name: 'cached', cacheTtlSeconds: 300 })
      .expect(201);
    const call = (effort: string) =>
      agent
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${key.body.key}`)
        .send({ ...ASK, temperature: 0, reasoning_effort: effort })
        .expect(200);

    expect((await call('low')).headers['x-gateway-cache']).toBe('miss');
    expect((await call('high')).headers['x-gateway-cache']).toBe('miss');
    expect((await call('low')).headers['x-gateway-cache']).toBe('hit');
    expect(received.map((b) => b.reasoning_effort)).toEqual(['low', 'high']);
  });

  it('names the fields it did not forward instead of dropping them silently', async () => {
    const agent = await arrange('openai_compatible');

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ ...ASK, seed: 7, presence_penalty: 0.5 })
      .expect(200);

    expect(res.headers['x-gateway-params-ignored']).toBe('presence_penalty,seed');
    expect(received[0]).not.toHaveProperty('seed');
  });

  it('says reasoning_effort was not applied on a Gemini connection, and still counts its reasoning tokens', async () => {
    const agent = await arrange('gemini');

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ ...ASK, reasoning_effort: 'low' })
      .expect(200);

    // Gemini counts thinking apart from `candidatesTokenCount`, and bills it as output.
    // OpenAI's shape counts reasoning inside `completion_tokens`, so the two are added.
    expect(res.body.usage).toEqual({
      prompt_tokens: 20,
      completion_tokens: 17,
      total_tokens: 37,
      reasoning_tokens: 9,
      completion_tokens_details: { reasoning_tokens: 9 },
    });
    expect(Number(res.headers['x-gateway-cost-usd'])).toBeCloseTo((20 + 17) / 1e6, 12);
    expect(res.headers['x-gateway-params-ignored']).toBe('reasoning_effort');
    expect(received[0]).not.toHaveProperty('reasoning_effort');
  });
});

/** Signs up a team whose `smart` model (gpt-5, down) falls back to `plain` (gpt-4o, no reasoning_effort). */
async function arrangeFallback() {
  const { agent } = await authedAgent(app);
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai_compatible', label: 'oai', apiKey: 'sk-zai-00000000000AB12', config: { base_url: `${origin}/v1` } })
    .expect(201);
  const plain = await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: 'plain', upstreamModel: 'gpt-4o', credentialId: conn.body.id, inputPricePerM: 1, outputPricePerM: 1 })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({
      publicName: 'smart',
      upstreamModel: 'gpt-5-down',
      credentialId: conn.body.id,
      inputPricePerM: 1,
      outputPricePerM: 1,
      fallbackModelIds: [plain.body.id],
    })
    .expect(201);
  return agent;
}

describe('reasoning_effort does not break calls that worked before it was forwarded', () => {
  // OpenAI marks the field nullable, and SDKs send `null` for "not set".
  it('accepts reasoning_effort: null and sends nothing upstream', async () => {
    const agent = await arrange('openai_compatible');

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ ...ASK, reasoning_effort: null })
      .expect(200);

    expect(res.body.choices[0].message.content).toBe('no');
    expect(received[0]).not.toHaveProperty('reasoning_effort');
  });

  // Before #593 the field was stripped, so a gpt-5 → gpt-4o chain answered from gpt-4o.
  // Forwarding it made gpt-4o answer 400, and a provider 400 stops the chain at once.
  it('retries a fallback model without reasoning_effort when that model refuses it', async () => {
    const agent = await arrangeFallback();

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'smart', messages: ASK.messages, reasoning_effort: 'low' })
      .expect(200);

    expect(res.headers['x-gateway-model']).toBe('gpt-4o');
    expect(res.headers['x-gateway-params-ignored']).toBe('reasoning_effort');
    // gpt-5 (503, retried once), gpt-4o with the field (400), gpt-4o without it (200).
    expect(received.map((b) => [b.model, b.reasoning_effort ?? null])).toEqual([
      ['gpt-5-down', 'low'],
      ['gpt-5-down', 'low'],
      ['gpt-4o', 'low'],
      ['gpt-4o', null],
    ]);
  });

  it('retries a streamed fallback model without reasoning_effort when that model refuses it', async () => {
    const agent = await arrangeFallback();

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'smart', messages: ASK.messages, stream: true, reasoning_effort: 'low' })
      .expect(200);

    expect(res.text).toContain('data: [DONE]');
    expect(res.headers['x-gateway-model']).toBe('gpt-4o');
    expect(res.headers['x-gateway-params-ignored']).toBe('reasoning_effort');
    expect(received.at(-1)).not.toHaveProperty('reasoning_effort');
  });

  // A 400 about something else is the caller's to see. The gateway must not retry it
  // without the field and answer at default effort.
  it('does not retry a 400 that is not about reasoning_effort', async () => {
    const agent = await arrange('openai_compatible');

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ ...ASK, reasoning_effort: 'low', max_tokens: 5 })
      .expect(400);
    expect(received).toHaveLength(1);
  });

  // A value the model does not know is the caller's mistake, even though the message names
  // the field. Retrying without it would answer at default effort and hide the typo.
  it('does not retry a 400 that rejects the value of reasoning_effort', async () => {
    const agent = await arrange('openai_compatible');

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ ...ASK, reasoning_effort: 'extreme' })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('reasoning_effort must be one of');
    expect(received).toHaveLength(1);
  });
});

describe('reasoning token counts in the place the OpenAI SDK reads them', () => {
  // The official OpenAI SDK reads `usage.completion_tokens_details.reasoning_tokens`.
  it('returns completion_tokens_details.reasoning_tokens on a non-streamed call', async () => {
    const agent = await arrange('openai_compatible');

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ ...ASK, reasoning_effort: 'low' })
      .expect(200);

    expect(res.body.usage.completion_tokens_details).toEqual({ reasoning_tokens: 9 });
    // The flat copy stays for callers that already read it.
    expect(res.body.usage.reasoning_tokens).toBe(9);
  });

  // `stream_options.include_usage` asks for a final chunk with `choices: []` and the usage.
  it('sends a usage chunk at the end of a stream when stream_options.include_usage is true', async () => {
    const agent = await arrange('openai_compatible');

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ ...ASK, stream: true, stream_options: { include_usage: true } })
      .expect(200);

    const frames = res.text
      .split('\n\n')
      .filter((f) => f.startsWith('data: {'))
      .map((f) => JSON.parse(f.slice(6)));
    const last = frames.at(-1);
    expect(last.choices).toEqual([]);
    expect(last.usage).toMatchObject({
      prompt_tokens: 20,
      completion_tokens: 17,
      total_tokens: 37,
      completion_tokens_details: { reasoning_tokens: 9 },
    });
    expect(res.headers['x-gateway-params-ignored']).toBeUndefined();
  });
});
