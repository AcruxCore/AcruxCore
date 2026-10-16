import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../tools/execute/safe-fetch';

const app = createApp();

/**
 * Gemini's usage block for a call whose prompt was mostly served from its cache.
 * `cachedContentTokenCount` is a subset of `promptTokenCount`, as Google documents it.
 */
const GEMINI_USAGE = { promptTokenCount: 1000, cachedContentTokenCount: 800, candidatesTokenCount: 10, totalTokenCount: 1010 };

/** The same cache hit as Google's OpenAI-compatible endpoint (or OpenRouter) reports it. */
const OPENAI_USAGE = {
  prompt_tokens: 1000,
  completion_tokens: 10,
  total_tokens: 1010,
  prompt_tokens_details: { cached_tokens: 800 },
};

let server: http.Server;
let origin: string;

beforeAll(async () => {
  allowLoopbackForTests();
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      if (req.url?.includes(':streamGenerateContent')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }] })}\n\n`);
        res.end(
          `data: ${JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }],
            usageMetadata: GEMINI_USAGE,
          })}\n\n`,
        );
        return;
      }
      if (req.url?.includes(':generateContent')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
            usageMetadata: GEMINI_USAGE,
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'gen-1',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
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

/**
 * Signs up a team with one connection pointed at the fake upstream and a `flash` model on it,
 * priced at $1 per 1M tokens both ways so the cost reads as a token count.
 */
async function arrange(
  provider: 'gemini' | 'openai_compatible',
  upstreamModel: string,
  cachedInputPricePerM?: number,
) {
  const { agent } = await authedAgent(app);
  const base = provider === 'gemini' ? `${origin}/v1beta` : `${origin}/v1`;
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider, label: provider, apiKey: 'sk-test-00000000000AB12', config: { base_url: base } })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({
      publicName: 'flash',
      upstreamModel,
      credentialId: conn.body.id,
      inputPricePerM: 1,
      outputPricePerM: 1,
      ...(cachedInputPricePerM === undefined ? {} : { cachedInputPricePerM }),
    })
    .expect(201);
  return agent;
}

const ASK = { model: 'flash', messages: [{ role: 'user', content: 'hello' }] };

/** 200 full-price prompt tokens + 800 cached at 0.1x + 10 output, at $1 per 1M. */
const GEMINI_DEFAULT_COST = (200 + 800 * 0.1 + 10) / 1e6;

describe('Gemini cached prompt tokens (issue #595)', () => {
  it('reports cachedContentTokenCount as cached_tokens and bills it at Gemini’s 0.1x', async () => {
    const agent = await arrange('gemini', 'gemini-2.5-flash');

    const res = await agent.post('/api/v1/gateway/chat/completions').send(ASK).expect(200);

    expect(res.body.usage).toMatchObject({ prompt_tokens: 1000, completion_tokens: 10, cached_tokens: 800 });
    expect(res.body.usage.prompt_tokens_details).toEqual({ cached_tokens: 800 });
    expect(Number(res.headers['x-gateway-cost-usd'])).toBeCloseTo(GEMINI_DEFAULT_COST, 12);

    // The ledger row and the traced span carry the same count and cost.
    const span = await prisma.span.findFirstOrThrow({ where: { traceId: res.headers['x-gateway-trace-id'] } });
    expect(span.cachedTokens).toBe(800);
    expect(span.costUsd?.toNumber()).toBeCloseTo(GEMINI_DEFAULT_COST, 12);
  });

  it('counts the cache hit on a streamed Gemini call too', async () => {
    const agent = await arrange('gemini', 'gemini-2.5-flash');

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ ...ASK, stream: true, stream_options: { include_usage: true } })
      .expect(200);

    const frames = res.text
      .split('\n\n')
      .map((l) => l.replace(/^data: /, ''))
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as { usage?: { cached_tokens?: number } });
    expect(frames.some((f) => f.usage?.cached_tokens === 800)).toBe(true);

    // This call's own ledger row: other tests write `flash` rows with the same cost.
    const row = await prisma.gatewayRequest.findUniqueOrThrow({ where: { id: res.headers['x-gateway-request-id'] } });
    expect(row.costUsd?.toNumber()).toBeCloseTo(GEMINI_DEFAULT_COST, 12);
  });

  it('uses the team’s own cached price over the Gemini default', async () => {
    const agent = await arrange('gemini', 'gemini-2.5-flash', 0.05);

    const res = await agent.post('/api/v1/gateway/chat/completions').send(ASK).expect(200);

    expect(Number(res.headers['x-gateway-cost-usd'])).toBeCloseTo((200 + 10) / 1e6 + (800 * 0.05) / 1e6, 12);
  });

  it('bills a Gemini model behind an OpenAI-compatible connection at Gemini’s rate', async () => {
    const agent = await arrange('openai_compatible', 'google/gemini-2.5-flash');

    const res = await agent.post('/api/v1/gateway/chat/completions').send(ASK).expect(200);

    expect(res.body.usage.cached_tokens).toBe(800);
    expect(Number(res.headers['x-gateway-cost-usd'])).toBeCloseTo(GEMINI_DEFAULT_COST, 12);
  });
});

describe('older Gemini models cache at 0.25x (review of PR #609)', () => {
  it('prices an SDK span of the built-in gemini-2.0-flash at 0.25x for cached tokens', async () => {
    const { agent, teamId } = await authedAgent(app);

    await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            name: 'old-gemini',
            spans: [
              {
                spanId: 's1',
                name: 'answer',
                kind: 'llm',
                status: 'ok',
                model: 'gemini-2.0-flash',
                usage: { promptTokens: 1000, completionTokens: 10, totalTokens: 1010, cachedTokens: 800 },
                startTime: '2026-10-10T10:00:00.000Z',
                endTime: '2026-10-10T10:00:00.100Z',
              },
            ],
          },
        ],
      })
      .expect(200);

    // Built-in price $0.10 in / $0.40 out per 1M; Google bills 2.0 cache reads at $0.025.
    const span = await prisma.span.findFirstOrThrow({ where: { teamId } });
    expect(span.costUsd?.toNumber()).toBeCloseTo((200 * 0.1 + 800 * 0.025 + 10 * 0.4) / 1e6, 12);
  });

  it('bills a team’s gemini-1.5-flash cache hit at 0.25x when the team set no cached price', async () => {
    const agent = await arrange('gemini', 'gemini-1.5-flash');

    const res = await agent.post('/api/v1/gateway/chat/completions').send(ASK).expect(200);

    expect(Number(res.headers['x-gateway-cost-usd'])).toBeCloseTo((200 + 800 * 0.25 + 10) / 1e6, 12);
  });
});
