import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../execute/safe-fetch';
import { signupTestUserWithApiKey } from '../../test-utils';

const app = createApp();
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ tempC: 18 }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  allowLoopbackForTests(); // in-process test-only SSRF seam (see TC4)
});

afterAll(async () => {
  resetSsrfAllowlist();
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE span_payloads, spans, traces, tool_aliases, tool_versions, tools, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});

describe('GET /tools/analytics', () => {
  it('aggregates calls, error rate, and latency by tool from tool spans', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const t = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'get_weather' })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: { type: 'object' }, executor: { type: 'http', url: `${baseUrl}/w`, method: 'GET' } })
      .expect(201);
    // 3 successful executions → 3 tool spans
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(`/api/v1/tools/${t.body.id}/execute`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ arguments: {} })
        .expect(200);
    }
    const res = await request(app).get('/api/v1/tools/analytics').set('Authorization', `Bearer ${apiKey}`).expect(200);
    const stat = res.body.data.find((s: { toolName: string }) => s.toolName === 'get_weather');
    expect(stat.calls).toBe(3);
    expect(stat.errorRate).toBe(0);
    expect(typeof stat.p50Ms).toBe('number');
  });

  it('isolates analytics across teams', async () => {
    const a = await signupTestUserWithApiKey(app);
    const b = await signupTestUserWithApiKey(app);
    const t = await request(app).post('/api/v1/tools').set('Authorization', `Bearer ${a.apiKey}`).send({ name: 'x' }).expect(201);
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/versions`)
      .set('Authorization', `Bearer ${a.apiKey}`)
      .send({ parametersSchema: { type: 'object' }, executor: { type: 'http', url: `${baseUrl}/w`, method: 'GET' } })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/execute`)
      .set('Authorization', `Bearer ${a.apiKey}`)
      .send({ arguments: {} })
      .expect(200);
    const res = await request(app).get('/api/v1/tools/analytics').set('Authorization', `Bearer ${b.apiKey}`).expect(200);
    expect(res.body.data).toEqual([]);
  });

  it('reports a non-zero errorRate for a tool whose executor request fails', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const t = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'broken_tool' })
      .expect(201);
    // Port 1 is a reserved/closed loopback port — connections are refused, so
    // safeFetch throws, errorMessage gets set, and recordSpan writes status: 'error'.
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: { type: 'object' }, executor: { type: 'http', url: 'http://127.0.0.1:1/w', method: 'GET' } })
      .expect(201);
    // The execute call itself still responds 400 (ValidationError thrown after the
    // span is recorded) — that is expected, not a test bug.
    await request(app)
      .post(`/api/v1/tools/${t.body.id}/execute`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ arguments: {} })
      .expect(400);
    const res = await request(app).get('/api/v1/tools/analytics').set('Authorization', `Bearer ${apiKey}`).expect(200);
    const stat = res.body.data.find((s: { toolName: string }) => s.toolName === 'broken_tool');
    expect(stat.calls).toBe(1);
    expect(stat.errorRate).toBe(1);
  });
});
