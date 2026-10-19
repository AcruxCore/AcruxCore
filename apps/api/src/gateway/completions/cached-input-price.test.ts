import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../tools/execute/safe-fetch';

const app = createApp();

/** z.ai's published glm-5.3 rates, USD per 1M tokens (issue #594). */
const IN = 1.4;
const CACHED = 0.26;
const OUT = 4.4;

/**
 * The usage z.ai returned for the second of three identical 739-token classify calls
 * (issue #594, record 11): 704 of the prompt tokens came from its cache.
 */
const CACHED_CALL_USAGE = {
  prompt_tokens: 739,
  completion_tokens: 155,
  total_tokens: 894,
  prompt_tokens_details: { cached_tokens: 704 },
};

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  allowLoopbackForTests();
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'billing' }, finish_reason: 'stop' }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: CACHED_CALL_USAGE })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'gen-1',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'billing' }, finish_reason: 'stop' }],
          usage: CACHED_CALL_USAGE,
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

/** Signs up a team with a z.ai-style connection pointed at the fake upstream. */
async function arrange() {
  const { agent } = await authedAgent(app);
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai_compatible', label: 'zai', apiKey: 'sk-zai-00000000000AB12', config: { base_url: baseUrl } })
    .expect(201);
  return { agent, credentialId: conn.body.id as string };
}

const ASK = { model: 'glm', messages: [{ role: 'user', content: 'Classify this ticket.' }] };

describe("a team model's cached input price (issue #594)", () => {
  it('stores, returns, updates and clears cachedInputPricePerM', async () => {
    const { agent, credentialId } = await arrange();

    const created = await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'glm', upstreamModel: 'glm-5.3', credentialId, inputPricePerM: IN, outputPricePerM: OUT, cachedInputPricePerM: CACHED })
      .expect(201);
    expect(created.body.cachedInputPricePerM).toBe(CACHED);

    const patched = await agent.patch(`/api/v1/gateway/models/${created.body.id}`).send({ cachedInputPricePerM: 0.3 }).expect(200);
    expect(patched.body.cachedInputPricePerM).toBe(0.3);

    const cleared = await agent.patch(`/api/v1/gateway/models/${created.body.id}`).send({ cachedInputPricePerM: null }).expect(200);
    expect(cleared.body.cachedInputPricePerM).toBeNull();

    const listed = await agent.get('/api/v1/gateway/models').expect(200);
    const rows = (Array.isArray(listed.body) ? listed.body : listed.body.data) as Array<{ id: string; cachedInputPricePerM: unknown }>;
    expect(rows.find((m) => m.id === created.body.id)?.cachedInputPricePerM).toBeNull();

    await agent.post('/api/v1/gateway/models').send({ publicName: 'neg', upstreamModel: 'x', credentialId, cachedInputPricePerM: -1 }).expect(400);
  });

  it("bills a cache hit at the team's cached price, not at the fixed 0.5x", async () => {
    const { agent, credentialId } = await arrange();
    await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'glm', upstreamModel: 'glm-5.3', credentialId, inputPricePerM: IN, outputPricePerM: OUT, cachedInputPricePerM: CACHED })
      .expect(201);

    const res = await agent.post('/api/v1/gateway/chat/completions').send(ASK).expect(200);

    // (35 x 1.40 + 704 x 0.26 + 155 x 4.40) / 1M = $0.00091404, the figure in the issue.
    const expected = (35 * IN + 704 * CACHED + 155 * OUT) / 1e6;
    expect(Number(res.headers['x-gateway-cost-usd'])).toBeCloseTo(expected, 12);
    const row = await prisma.gatewayRequest.findUniqueOrThrow({ where: { id: res.headers['x-gateway-request-id'] } });
    expect(row.costUsd?.toNumber()).toBeCloseTo(expected, 9);
    // The gateway's own span keeps the cached count too.
    const spans = await prisma.$queryRaw<Array<{ cached_tokens: number | null }>>`
      SELECT cached_tokens FROM spans WHERE gateway_request_id = ${row.id}::uuid`;
    expect(spans).toEqual([{ cached_tokens: 704 }]);
  });

  // Review of #594: the cached price was turned into a fraction of the input price, so a
  // model whose input price is $0 had its cached price ignored.
  it('bills the cached price even when the input price is zero', async () => {
    const { agent, credentialId } = await arrange();
    await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'glm', upstreamModel: 'glm-5.3', credentialId, inputPricePerM: 0, outputPricePerM: OUT, cachedInputPricePerM: CACHED })
      .expect(201);

    const res = await agent.post('/api/v1/gateway/chat/completions').send(ASK).expect(200);

    expect(Number(res.headers['x-gateway-cost-usd'])).toBeCloseTo((704 * CACHED + 155 * OUT) / 1e6, 12);
  });

  it('bills a streamed cache hit the same way', async () => {
    const { agent, credentialId } = await arrange();
    await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'glm', upstreamModel: 'glm-5.3', credentialId, inputPricePerM: IN, outputPricePerM: OUT, cachedInputPricePerM: CACHED })
      .expect(201);

    const res = await agent.post('/api/v1/gateway/chat/completions').send({ ...ASK, stream: true }).expect(200);

    const row = await prisma.gatewayRequest.findUniqueOrThrow({ where: { id: res.headers['x-gateway-request-id'] } });
    expect(row.costUsd?.toNumber()).toBeCloseTo((35 * IN + 704 * CACHED + 155 * OUT) / 1e6, 9);
  });

  it('keeps the provider default (0.5x) for a model with no cached price', async () => {
    const { agent, credentialId } = await arrange();
    await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'glm', upstreamModel: 'glm-5.3', credentialId, inputPricePerM: IN, outputPricePerM: OUT })
      .expect(201);

    const res = await agent.post('/api/v1/gateway/chat/completions').send(ASK).expect(200);

    // $0.0012238, the "recorded" figure in the issue.
    expect(Number(res.headers['x-gateway-cost-usd'])).toBeCloseTo((35 * IN + 704 * IN * 0.5 + 155 * OUT) / 1e6, 12);
  });
});

// `String(number)` printed full float64 noise into the header — `0.00005909999999999999`
// on a real gpt-4o-mini call (issue #422). The stored cost is unaffected.
describe('x-gateway-cost-usd formatting (issue #422)', () => {
  it('rounds the header to at most 10 decimal places with no trailing zeros', async () => {
    const { agent, credentialId } = await arrange();
    // gpt-4o-mini's rates: these produce a cost that is not exact in binary floating point.
    await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'glm', upstreamModel: 'glm-5.3', credentialId, inputPricePerM: 0.15, outputPricePerM: 0.6 })
      .expect(201);

    const res = await agent.post('/api/v1/gateway/chat/completions').send(ASK).expect(200);

    const header = res.headers['x-gateway-cost-usd'] as string;
    expect(header).toMatch(/^\d+(\.\d{0,9}[1-9])?$/);
    const row = await prisma.gatewayRequest.findUniqueOrThrow({ where: { id: res.headers['x-gateway-request-id'] } });
    expect(Number(header)).toBeCloseTo(row.costUsd!.toNumber(), 10);
  });
});
