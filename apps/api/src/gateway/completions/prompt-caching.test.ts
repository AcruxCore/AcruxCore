import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../tools/execute/safe-fetch';

const app = createApp();

/** A long, fixed system message — the shape that issue #552 is about. */
const DOCS = 'You answer from these docs: {{ product }} ships in 3 days.';

/**
 * Usage that OpenRouter really returns for an Anthropic model on a cache hit
 * (captured 2026-10-10): `prompt_tokens` already includes both cache fields.
 */
const CACHE_HIT_USAGE = {
  prompt_tokens: 1_000_000,
  completion_tokens: 0,
  total_tokens: 1_000_000,
  prompt_tokens_details: { cached_tokens: 600_000, cache_write_tokens: 400_000 },
};

/** Every request body the fake upstream received, newest last. */
let received: Array<{ model: string; messages: Array<Record<string, unknown>>; stream?: boolean }> = [];
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  allowLoopbackForTests();
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      received.push(body);
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: CACHE_HIT_USAGE })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'gen-1',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: CACHE_HIT_USAGE,
        }),
      );
    });
  });
  // `localhost`, not 127.0.0.1: the connection schema refuses a literal loopback IP.
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}/v1`;
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

/**
 * Signs up a team with an OpenRouter-style connection pointed at the fake upstream,
 * registers `publicName` → `upstreamModel` at $1/M input, and commits a prompt whose
 * system message is marked for caching.
 */
async function arrange(publicName: string, upstreamModel: string) {
  const { agent } = await authedAgent(app);
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai_compatible', label: 'or', apiKey: 'sk-or-000000000000AB12', config: { base_url: baseUrl } })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName, upstreamModel, credentialId: conn.body.id, inputPricePerM: 1, outputPricePerM: 1 })
    .expect(201);
  const prompt = await agent.post('/api/v1/prompts').send({ name: `docs-${Date.now()}` }).expect(201);
  const version = await agent
    .post(`/api/v1/prompts/${prompt.body.id}/versions`)
    .send({
      messages: [
        { role: 'system', content: DOCS, cache_control: { type: 'ephemeral' } },
        { role: 'user', content: 'When does it ship?' },
      ],
    })
    .expect(201);
  return { agent, promptName: prompt.body.name as string, promptId: prompt.body.id as string, version: version.body };
}

describe('Anthropic prompt caching through a prompt version (issue #552)', () => {
  it('stores the marker, sends it as a cache block to an Anthropic model, and bills reads at 0.1x and writes at 1.25x', async () => {
    const { agent, promptName, promptId, version } = await arrange('haiku', 'anthropic/claude-haiku-5.5');

    // The marker survives the commit and the read-back.
    expect(version.messages[0]).toEqual({ role: 'system', content: DOCS, cache_control: { type: 'ephemeral' } });
    const fetched = await agent.get(`/api/v1/prompts/${promptId}/versions/1`).expect(200);
    expect(fetched.body.messages[0].cache_control).toEqual({ type: 'ephemeral' });

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'haiku', prompt: { name: promptName, alias: 'production', variables: { product: 'Lamp' } } })
      .expect(200);

    // The rendered text goes out as a content block carrying cache_control.
    expect(received).toHaveLength(1);
    expect(received[0]!.messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'You answer from these docs: Lamp ships in 3 days.', cache_control: { type: 'ephemeral' } }],
    });
    // An unmarked message stays a plain string.
    expect(received[0]!.messages[1]).toEqual({ role: 'user', content: 'When does it ship?' });

    // 600K reads at $0.10/M + 400K writes at $1.25/M = $0.06 + $0.50 = $0.56.
    // Billed as if uncached it would be $1.00; at OpenAI's 0.5x read rate, $0.70.
    const row = await prisma.gatewayRequest.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    expect(Number(row.costUsd)).toBeCloseTo(0.56, 6);
  });

  it('bills the cache on a streamed call too', async () => {
    const { agent, promptName } = await arrange('haiku', 'anthropic/claude-haiku-5.5');

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'haiku', stream: true, prompt: { name: promptName, alias: 'production', variables: { product: 'Lamp' } } })
      .expect(200);

    expect(received[0]!.messages[0]!.content).toEqual([
      { type: 'text', text: 'You answer from these docs: Lamp ships in 3 days.', cache_control: { type: 'ephemeral' } },
    ]);
    const row = await prisma.gatewayRequest.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    expect(Number(row.costUsd)).toBeCloseTo(0.56, 6);
  });

  it('strips the marker for a non-Anthropic model, so the same version still runs anywhere', async () => {
    const { agent, promptName } = await arrange('llama', 'meta-llama/llama-3.3-70b-instruct');

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'llama', prompt: { name: promptName, alias: 'production', variables: { product: 'Lamp' } } })
      .expect(200);

    expect(received[0]!.messages[0]).toEqual({ role: 'system', content: 'You answer from these docs: Lamp ships in 3 days.' });
  });

  it('accepts the marker on ad-hoc gateway messages', async () => {
    const { agent } = await arrange('haiku', 'anthropic/claude-haiku-5.5');

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'haiku',
        messages: [
          { role: 'system', content: 'Fixed docs', cache_control: { type: 'ephemeral' } },
          { role: 'user', content: 'hi' },
        ],
      })
      .expect(200);

    expect(received[0]!.messages[0]!.content).toEqual([
      { type: 'text', text: 'Fixed docs', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('rejects a cache_control type Anthropic does not know', async () => {
    const { agent, promptId } = await arrange('haiku', 'anthropic/claude-haiku-5.5');

    const res = await agent
      .post(`/api/v1/prompts/${promptId}/versions`)
      .send({ messages: [{ role: 'system', content: 'x', cache_control: { type: 'forever' } }] });

    expect(res.status).toBe(400);
  });
});

void request;
