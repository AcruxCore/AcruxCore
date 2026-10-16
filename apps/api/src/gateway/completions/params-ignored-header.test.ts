import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../tools/execute/safe-fetch';

const app = createApp();

const USAGE = { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 };

let server: http.Server;
let origin: string;

beforeAll(async () => {
  allowLoopbackForTests();
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'no' }, finish_reason: 'stop' }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: USAGE })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'gen-1',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'no' }, finish_reason: 'stop' }],
          usage: USAGE,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  resetSsrfAllowlist();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

/** Signs up a team with one priced `glm` model on an openai_compatible connection to the fake upstream. */
async function arrange() {
  const { agent, teamId } = await authedAgent(app);
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai_compatible', label: 'zai', apiKey: 'sk-zai-00000000000AB12', config: { base_url: `${origin}/v1` } })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: 'glm', upstreamModel: 'glm-5.3', credentialId: conn.body.id, inputPricePerM: 1, outputPricePerM: 1 })
    .expect(201);
  return { agent, teamId };
}

const ASK = { model: 'glm', messages: [{ role: 'user', content: 'Is 1001 a prime number?' }] };

describe('x-gateway-params-ignored never breaks the call it describes', () => {
  // A header value must be Latin-1, and Node throws on anything else. The header was set
  // after the provider call was billed, so the caller got a 500 for a call they paid for.
  it('answers 200 when an unknown field name is not Latin-1, and names it percent-encoded', async () => {
    const { agent, teamId } = await arrange();

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ ...ASK, 温度: 0.2 })
      .expect(200);

    expect(res.body.choices[0].message.content).toBe('no');
    expect(res.headers['x-gateway-params-ignored']).toBe(encodeURIComponent('温度'));
    expect(res.headers['x-gateway-params-ignored-count']).toBe('1');
    expect(await prisma.gatewayRequest.count({ where: { teamId, status: 'success' } })).toBe(1);
  });

  // On a stream the same throw also skipped `finalize`, so no ledger row was written and
  // the budget reservation was never reconciled.
  it('streams, and records the request row, when an unknown field name is not Latin-1', async () => {
    const { agent, teamId } = await arrange();

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ ...ASK, stream: true, 'bad\nname': 1 })
      .expect(200);

    expect(res.text).toContain('data: [DONE]');
    expect(res.headers['x-gateway-params-ignored']).toBe(encodeURIComponent('bad\nname'));
    expect(await prisma.gatewayRequest.count({ where: { teamId, status: 'success' } })).toBe(1);
  });

  // Thousands of unknown keys made a response header too large for a client or proxy to read.
  it('keeps the header short when a body has thousands of unknown fields, and gives the full count', async () => {
    const { agent } = await arrange();
    const extra = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`field_${i}`, i]));

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ ...ASK, ...extra })
      .expect(200);

    expect(res.headers['x-gateway-params-ignored'].length).toBeLessThanOrEqual(1024);
    expect(res.headers['x-gateway-params-ignored'].split(',')[0]).toBe('field_0');
    expect(res.headers['x-gateway-params-ignored-count']).toBe('3000');
  });
});
