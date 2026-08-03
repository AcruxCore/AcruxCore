import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

const RANGE = 'from=2026-06-01&to=2026-07-01';

/** OpenAI-shaped body returned by the mocked provider fetch in the superset test. */
const OPENAI_RESPONSE = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
};

/** Seeds two SDK spans on 2026-06-10 (llm gpt-4o-mini, latencies 100 & 300 ms) via POST /traces. */
async function seedTwoSpans(agent: ReturnType<typeof request.agent>): Promise<void> {
  await agent
    .post('/api/v1/traces')
    .send({
      traces: [
        {
          sessionId: 'sess-1',
          name: 't',
          spans: [
            { spanId: 's1', name: 'gpt-4o-mini', kind: 'llm', status: 'ok', model: 'gpt-4o-mini', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 }, costUsd: 0.001, startTime: '2026-06-10T10:00:00.000Z', endTime: '2026-06-10T10:00:00.100Z' },
            { spanId: 's2', name: 'gpt-4o-mini', kind: 'llm', status: 'ok', model: 'gpt-4o-mini', usage: { promptTokens: 200, completionTokens: 40, totalTokens: 240 }, costUsd: 0.002, startTime: '2026-06-10T10:00:01.000Z', endTime: '2026-06-10T10:00:01.300Z' },
          ],
        },
      ],
    })
    .expect(200);
}

/**
 * Seeds one `llm` span (model gpt-4o-mini, session sess-a) and one `retrieval`
 * span (no model, session sess-b), both on 2026-06-10, via POST /traces. Used to
 * exercise group_by variants (model/session) and the kind/model filters.
 */
async function seedMixedSpans(agent: ReturnType<typeof request.agent>): Promise<void> {
  await agent
    .post('/api/v1/traces')
    .send({
      traces: [
        {
          sessionId: 'sess-a',
          name: 't',
          spans: [
            { spanId: 'm1', name: 'gpt-4o-mini', kind: 'llm', status: 'ok', model: 'gpt-4o-mini', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }, costUsd: 0.001, startTime: '2026-06-10T10:00:00.000Z', endTime: '2026-06-10T10:00:00.100Z' },
          ],
        },
        {
          sessionId: 'sess-b',
          name: 't',
          spans: [
            { spanId: 'm2', name: 'retrieve', kind: 'retrieval', status: 'ok', startTime: '2026-06-10T10:00:00.000Z', endTime: '2026-06-10T10:00:00.050Z' },
          ],
        },
      ],
    })
    .expect(200);
}

/**
 * Registers a model whose public name equals its upstream name (so mocked tests
 * can call `model: '<name>'`), bound to the given credential.
 */
async function registerModel(
  agent: ReturnType<typeof request.agent>,
  credentialId: string,
  name: string,
): Promise<void> {
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: name, upstreamModel: name, credentialId })
    .expect(201);
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
    span_payloads, spans, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys, provider_connections,
    audit_log, prompt_aliases, prompt_versions, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/v1/traces/analytics', () => {
  it('returns the envelope with nested latency percentiles and echoed range', async () => {
    const { agent } = await authedAgent(app);
    await seedTwoSpans(agent);

    const res = await agent.get(`/api/v1/traces/analytics?${RANGE}`).expect(200);

    expect(res.body.from).toBe('2026-06-01');
    expect(res.body.to).toBe('2026-07-01');
    expect(res.body.groupBy).toBe('day'); // default
    expect(res.body.totals.requests).toBe(2);
    expect(res.body.totals.totalTokens).toBe(360);
    expect(res.body.totals.costUsd).toBeCloseTo(0.003, 6);
    // latencies [100, 300] (n=2): p50 = 200, p95 = 290, p99 = 298
    expect(res.body.totals.latencyMs.p50).toBeCloseTo(200, 6);
    expect(res.body.totals.latencyMs.p95).toBeCloseTo(290, 6);
    expect(res.body.totals.latencyMs.p99).toBeCloseTo(298, 6);

    const day = res.body.buckets.find((b: { key: string }) => b.key === '2026-06-10');
    expect(day.requests).toBe(2);
    expect(day.latencyMs.p50).toBeCloseTo(200, 6);
  });

  it('defaults the window to the last 30 days when from/to are omitted', async () => {
    const { agent } = await authedAgent(app);
    // A span "now" so it lands inside the default [now-30d, now) window.
    const start = new Date();
    const end = new Date(start.getTime() + 100);
    await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            sessionId: 'recent',
            name: 't',
            spans: [
              { spanId: 'r1', name: 'gpt-4o-mini', kind: 'llm', status: 'ok', model: 'gpt-4o-mini', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }, costUsd: 0.001, startTime: start.toISOString(), endTime: end.toISOString() },
            ],
          },
        ],
      })
      .expect(200);

    const res = await agent.get('/api/v1/traces/analytics').expect(200);
    expect(res.body.groupBy).toBe('day');
    expect(res.body.totals.requests).toBe(1);
  });

  it('returns 400 VALIDATION_ERROR for an invalid group_by', async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get('/api/v1/traces/analytics?group_by=banana').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR for an invalid kind', async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get('/api/v1/traces/analytics?kind=nope').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR when from is after to', async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get('/api/v1/traces/analytics?from=2026-07-01&to=2026-06-01').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('group_by=model buckets by model, omitting the null-model span', async () => {
    const { agent } = await authedAgent(app);
    await seedMixedSpans(agent);

    const res = await agent.get(`/api/v1/traces/analytics?group_by=model&${RANGE}`).expect(200);
    expect(res.body.groupBy).toBe('model');
    // The retrieval span has no model → its bucket key is null and is dropped by the repo.
    expect(res.body.buckets).toHaveLength(1);
    expect(res.body.buckets[0]).toMatchObject({ key: 'gpt-4o-mini', requests: 1 });
    expect(res.body.totals.requests).toBe(2); // totals still count both spans
  });

  it('group_by=session buckets by session id', async () => {
    const { agent } = await authedAgent(app);
    await seedMixedSpans(agent);

    const res = await agent.get(`/api/v1/traces/analytics?group_by=session&${RANGE}`).expect(200);
    expect(res.body.groupBy).toBe('session');
    expect(res.body.buckets).toHaveLength(2);
    const keys = res.body.buckets.map((b: { key: string }) => b.key).sort();
    expect(keys).toEqual(['sess-a', 'sess-b']);
  });

  it('the kind filter narrows totals to spans of that kind', async () => {
    const { agent } = await authedAgent(app);
    await seedMixedSpans(agent);

    const res = await agent.get(`/api/v1/traces/analytics?kind=llm&${RANGE}`).expect(200);
    expect(res.body.totals.requests).toBe(1);
  });

  it('the model filter narrows totals to spans with that model, excluding null-model spans', async () => {
    const { agent } = await authedAgent(app);
    await seedMixedSpans(agent);

    const res = await agent.get(`/api/v1/traces/analytics?model=gpt-4o-mini&${RANGE}`).expect(200);
    expect(res.body.totals.requests).toBe(1);
  });

  it('never includes another team spans (isolation)', async () => {
    const a = await authedAgent(app);
    await seedTwoSpans(a.agent);
    const b = await authedAgent(app); // b seeds nothing

    const res = await b.agent.get(`/api/v1/traces/analytics?${RANGE}`).expect(200);
    expect(res.body.totals.requests).toBe(0);
    expect(res.body.buckets).toHaveLength(0);
    expect(res.body.totals.latencyMs.p50).toBeNull(); // empty group → null percentiles
  });

  it('aggregates BOTH a gateway-minted span and an SDK span (superset over G8)', async () => {
    const { agent } = await authedAgent(app);

    // 1) A real gateway completion (mocked provider) → T1 hook writes a gateway llm span.
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(OPENAI_RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const connRes = await agent
      .post('/api/v1/gateway/connections')
      .send({ provider: 'openai', label: 't', apiKey: 'sk-test-000000000000AB12', config: {} })
      .expect(201);
    await registerModel(agent, connRes.body.id, 'gpt-4o-mini');
    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
      .expect(200);

    // 2) An SDK-reported span (gateway_request_id null) via POST /traces, "now" so both
    //    fall in the default 30-day window.
    const start = new Date();
    await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            sessionId: 'sdk',
            name: 'sdk-trace',
            spans: [
              { spanId: 'sdk1', name: 'retrieve', kind: 'retrieval', status: 'ok', startTime: start.toISOString(), endTime: new Date(start.getTime() + 50).toISOString() },
            ],
          },
        ],
      })
      .expect(200);

    // Default window → both spans counted. G8's gateway-only usage would see just 1.
    const res = await agent.get('/api/v1/traces/analytics').expect(200);
    expect(res.body.totals.requests).toBe(2);
  });

  it('mount ordering: /traces/analytics, /traces/:id, and /traces/settings all resolve to their own handlers', async () => {
    const { agent } = await authedAgent(app);
    await seedTwoSpans(agent);
    const traceId = (await agent.get('/api/v1/traces').expect(200)).body.data[0].id;

    // /traces/analytics must hit the analytics envelope, NOT be swallowed as a :id lookup.
    const analytics = await agent.get('/api/v1/traces/analytics').expect(200);
    expect(analytics.body).toHaveProperty('totals');
    expect(analytics.body).toHaveProperty('buckets');

    // /traces/:id must still resolve to a real trace, not be shadowed by anything static.
    const trace = await agent.get(`/api/v1/traces/${traceId}`).expect(200);
    expect(trace.body.trace.id).toBe(traceId);

    // /traces/settings (T1, static) must still resolve to the settings envelope.
    const settings = await agent.get('/api/v1/traces/settings').expect(200);
    expect(settings.body).toHaveProperty('capturePayloads');
  });
});
