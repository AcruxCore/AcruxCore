import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { allowLoopbackForTests, resetSsrfAllowlist } from './safe-fetch';
import { MAX_TRANSFORM_RESULT_CHARS } from './js-transform';
import { signupTestUserWithApiKey } from '../../test-utils';

const app = createApp();
let server: http.Server;
let baseUrl: string;
/** Size of every request body the upstream received, newest last. */
const received: number[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let bytes = 0;
    req.on('data', (c: Buffer) => (bytes += c.length));
    req.on('end', () => {
      received.push(bytes);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  allowLoopbackForTests();
});

afterAll(async () => {
  resetSsrfAllowlist();
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
});

beforeEach(() => {
  received.length = 0;
});

/** A transform of a few dozen bytes whose result is `8 * 2^doublings` characters long. */
function doubling(doublings: number): string {
  return `function transform(input) { let s = 'aaaaaaaa'; for (let i = 0; i < ${doublings}; i++) s = s + s; return { s }; }`;
}

/** Signs up a team and commits an http tool with the given transforms; returns its id + key. */
async function toolWith(transforms: { requestTransform?: string; responseTransform?: string }) {
  const { apiKey } = await signupTestUserWithApiKey(app);
  const t = await request(app)
    .post('/api/v1/tools')
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ name: `sized_${Math.random().toString(36).slice(2, 8)}` })
    .expect(201);
  await request(app)
    .post(`/api/v1/tools/${t.body.id}/versions`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({
      parametersSchema: { type: 'object' },
      executor: { type: 'http', url: `${baseUrl}/echo`, method: 'POST', ...transforms },
    })
    .expect(201);
  return { apiKey, toolId: t.body.id as string };
}

function execute(apiKey: string, toolId: string) {
  return request(app)
    .post(`/api/v1/tools/${toolId}/execute`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ arguments: {} });
}

describe('a transform result is bounded in size, not only in time', () => {
  it('rejects a response transform that returns just over the limit with a 400', async () => {
    // 8 * 2^18 = 2 Mi characters, plus the `{"s":""}` around them.
    const { apiKey, toolId } = await toolWith({ responseTransform: doubling(18) });

    const res = await execute(apiKey, toolId);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/character limit/);
  });

  it('rejects a request transform that returns just over the limit before anything is sent', async () => {
    const { apiKey, toolId } = await toolWith({ requestTransform: doubling(18) });

    const res = await execute(apiKey, toolId);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/character limit/);
    expect(received).toHaveLength(0);
  });

  it('rejects a transform that builds 16 Mi characters, which no longer fits its memory once encoded', async () => {
    const { apiKey, toolId } = await toolWith({ responseTransform: doubling(21) });

    const res = await execute(apiKey, toolId);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/memory limit|character limit/);
  });

  it('still returns a large result under the limit unchanged', async () => {
    // 8 * 2^16 = 512 Ki characters.
    const { apiKey, toolId } = await toolWith({ responseTransform: doubling(16) });

    const res = await execute(apiKey, toolId).expect(200);

    expect(res.body.result.s).toHaveLength(8 * 2 ** 16);
    expect(8 * 2 ** 16).toBeLessThan(MAX_TRANSFORM_RESULT_CHARS);
  });

  it('keeps plain JSON results as they were', async () => {
    const { apiKey, toolId } = await toolWith({
      requestTransform: 'function transform(input) { return { q: "Paris", n: [1, 2.5, null, true] }; }',
      responseTransform: 'function transform(input) { return input.body.ok ? "fine" : "bad"; }',
    });

    const res = await execute(apiKey, toolId).expect(200);

    expect(res.body.result).toBe('fine');
    expect(received[0]).toBe(JSON.stringify({ q: 'Paris', n: [1, 2.5, null, true] }).length);
  });
});
