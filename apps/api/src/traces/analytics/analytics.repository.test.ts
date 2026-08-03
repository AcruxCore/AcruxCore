import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { AnalyticsRepository } from './analytics.repository';
import { authedAgent } from '../../test-utils';

const app = createApp();
const repo = new AnalyticsRepository();

const FROM = new Date('2026-06-01T00:00:00Z');
const TO = new Date('2026-07-01T00:00:00Z');

let teamId: string;
let pv1: string;

/**
 * Signs up an owner (real team + session), creates prompt "greeting" + version 1
 * (to obtain a real prompt_version_id FK), and seeds the 6-span fixture via the
 * real POST /traces ingest path. Returns nothing — sets module-level teamId/pv1.
 */
async function arrange(): Promise<ReturnType<typeof request.agent>> {
  const { agent, teamId: tid } = await authedAgent(app);
  teamId = tid;

  const p = await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201);
  const v1 = await agent
    .post(`/api/v1/prompts/${p.body.id}/versions`)
    .send({ messages: [{ role: 'system', content: 'Hello {{ name }}' }] })
    .expect(201);
  pv1 = v1.body.id;

  await agent
    .post('/api/v1/traces')
    .send({
      traces: [
        {
          sessionId: 'sess-A',
          name: 'trace-A',
          spans: [
            { spanId: 'a1', name: 'gpt-4o-mini', kind: 'llm', status: 'ok', model: 'gpt-4o-mini', promptVersionId: pv1, usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 }, costUsd: 0.001, startTime: '2026-06-10T10:00:00.000Z', endTime: '2026-06-10T10:00:00.100Z' },
            { spanId: 'a2', name: 'gpt-4o-mini', kind: 'llm', status: 'ok', model: 'gpt-4o-mini', promptVersionId: pv1, usage: { promptTokens: 200, completionTokens: 40, totalTokens: 240 }, costUsd: 0.002, startTime: '2026-06-10T10:00:01.000Z', endTime: '2026-06-10T10:00:01.200Z' },
          ],
        },
        {
          sessionId: 'sess-B',
          name: 'trace-B',
          spans: [
            { spanId: 'b1', name: 'gpt-4o', kind: 'llm', status: 'ok', model: 'gpt-4o', usage: { promptTokens: 300, completionTokens: 60, totalTokens: 360 }, costUsd: 0.010, startTime: '2026-06-11T10:00:00.000Z', endTime: '2026-06-11T10:00:00.300Z' },
            { spanId: 'b2', name: 'gpt-4o', kind: 'llm', status: 'error', error: 'boom', model: 'gpt-4o', usage: { promptTokens: 150, completionTokens: 30, totalTokens: 180 }, startTime: '2026-06-11T10:00:01.000Z', endTime: '2026-06-11T10:00:01.500Z' },
            { spanId: 'b3', name: 'search', kind: 'tool', status: 'ok', startTime: '2026-06-11T10:00:02.000Z', endTime: '2026-06-11T10:00:02.400Z' },
            { spanId: 'b4', name: 'gpt-4o-mini', kind: 'llm', status: 'ok', model: 'gpt-4o-mini', usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 }, costUsd: 0.001, startTime: '2026-06-11T10:00:03.000Z' },
          ],
        },
      ],
    })
    .expect(200);

  return agent;
}

beforeEach(async () => {
  // Children-first: Phase 3 (no trace_feedback — that's a T6 table, absent when T5 runs),
  // then Phase 2, then Phase 1.
  await prisma.$executeRaw`TRUNCATE TABLE
    span_payloads, spans, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys, provider_connections,
    audit_log, prompt_aliases, prompt_versions, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('AnalyticsRepository.bucket — totals', () => {
  it('computes range totals with percentiles, treating null cost as 0', async () => {
    await arrange();
    const { totals } = await repo.bucket(teamId, { from: FROM, to: TO, groupBy: 'day' });
    expect(totals.requests).toBe(6);
    expect(totals.errorRate).toBeCloseTo(1 / 6, 6);
    expect(totals.promptTokens).toBe(800);
    expect(totals.completionTokens).toBe(160);
    expect(totals.totalTokens).toBe(960);
    expect(totals.costUsd).toBeCloseTo(0.014, 6);
    expect(totals.latencyMs.p50).toBeCloseTo(300, 6);
    expect(totals.latencyMs.p95).toBeCloseTo(480, 6);
    expect(totals.latencyMs.p99).toBeCloseTo(496, 6);
  });
});

describe('AnalyticsRepository.bucket — grouping', () => {
  it('group_by=day: per-day buckets and percentiles', async () => {
    await arrange();
    const { buckets } = await repo.bucket(teamId, { from: FROM, to: TO, groupBy: 'day' });
    const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
    expect(byKey['2026-06-10'].requests).toBe(2);
    expect(byKey['2026-06-10'].costUsd).toBeCloseTo(0.003, 6);
    expect(byKey['2026-06-10'].latencyMs.p50).toBeCloseTo(150, 6);
    expect(byKey['2026-06-10'].latencyMs.p95).toBeCloseTo(195, 6);
    expect(byKey['2026-06-11'].requests).toBe(4);
    expect(byKey['2026-06-11'].errorRate).toBeCloseTo(0.25, 6);
    expect(byKey['2026-06-11'].latencyMs.p50).toBeCloseTo(400, 6);
    expect(byKey['2026-06-11'].latencyMs.p99).toBeCloseTo(498, 6);
  });

  it('group_by=model: null-model span excluded from buckets, sums partition', async () => {
    await arrange();
    const { buckets } = await repo.bucket(teamId, { from: FROM, to: TO, groupBy: 'model' });
    const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
    expect(Object.keys(byKey).sort()).toEqual(['gpt-4o', 'gpt-4o-mini']); // tool span (null model) dropped
    expect(byKey['gpt-4o-mini'].requests).toBe(3);
    // a1 (0.001) + a2 (0.002) + b4 (0.001) = 0.004. (The task brief's fixture
    // table states 0.003 for this bucket, which is an arithmetic error there —
    // hand-summing the seeded costUsd values for a1/a2/b4 gives 0.004.)
    expect(byKey['gpt-4o-mini'].costUsd).toBeCloseTo(0.004, 6);
    expect(byKey['gpt-4o-mini'].latencyMs.p50).toBeCloseTo(150, 6);
    expect(byKey['gpt-4o'].requests).toBe(2);
    expect(byKey['gpt-4o'].latencyMs.p50).toBeCloseTo(400, 6);
    expect(byKey['gpt-4o'].latencyMs.p99).toBeCloseTo(498, 6);
  });

  it('group_by=session: buckets keyed by session id', async () => {
    await arrange();
    const { buckets } = await repo.bucket(teamId, { from: FROM, to: TO, groupBy: 'session' });
    const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
    expect(byKey['sess-A'].requests).toBe(2);
    expect(byKey['sess-B'].requests).toBe(4);
  });

  it('group_by=prompt_version: only spans carrying that version counted, keyed by "<name> vN" not the raw uuid', async () => {
    await arrange();
    const { buckets } = await repo.bucket(teamId, { from: FROM, to: TO, groupBy: 'prompt_version' });
    expect(buckets).toHaveLength(1); // null prompt_version_id spans filtered out
    expect(buckets[0].key).toBe('greeting v1');
    expect(buckets[0].requests).toBe(2);
  });
});

describe('AnalyticsRepository.bucket — model alias resolution', () => {
  it('group_by=model: a span linked to a gateway request is keyed by the registered publicName, not the resolved upstream model', async () => {
    const agent = await arrange();

    // Register a model whose public alias differs from the upstream model id,
    // then drive a real (adapter-mocked) gateway completion through it so a span
    // gets written with gateway_request_id set (mirrors gateway-trace.hook.ts).
    const cred = await agent
      .post('/api/v1/gateway/connections')
      .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12' })
      .expect(201);
    await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'prod-mini', upstreamModel: 'gpt-4o-mini', credentialId: cred.body.id })
      .expect(201);
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-analytics',
        object: 'chat.completion',
        created: 1751536800,
        model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }),
      text: async () => '',
    } as unknown as Response);
    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'prod-mini', messages: [{ role: 'user', content: 'hi' }] })
      .expect(200);
    jest.restoreAllMocks();

    const { buckets } = await repo.bucket(teamId, { from: FROM, to: new Date(), groupBy: 'model' });
    const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
    expect(byKey['prod-mini']).toBeDefined();
    expect(byKey['prod-mini'].requests).toBe(1);
    // The 3 unrelated SDK-reported spans from arrange() (no gateway_request_id)
    // still fall back to the raw model string and stay their own bucket — the
    // new gateway-routed request must NOT have folded into it (that'd mean the
    // publicName resolution silently failed and fell back to the raw id too).
    expect(byKey['gpt-4o-mini'].requests).toBe(3);
  });
});

describe('AnalyticsRepository.bucket — filters', () => {
  it('kind=tool restricts to tool spans', async () => {
    await arrange();
    const { totals } = await repo.bucket(teamId, { from: FROM, to: TO, groupBy: 'day', kind: 'tool' });
    expect(totals.requests).toBe(1);
    expect(totals.promptTokens).toBe(0);
    expect(totals.costUsd).toBeCloseTo(0, 6);
    expect(totals.latencyMs.p50).toBeCloseTo(400, 6);
  });

  it('model filter narrows to that model', async () => {
    await arrange();
    const { totals } = await repo.bucket(teamId, { from: FROM, to: TO, groupBy: 'day', model: 'gpt-4o-mini' });
    expect(totals.requests).toBe(3);
    expect(totals.promptTokens).toBe(350);
  });

  it('null-latency span is counted in requests but excluded from percentiles', async () => {
    await arrange();
    // b4 (gpt-4o-mini, null latency) is counted in requests but must not affect p50.
    const { totals } = await repo.bucket(teamId, { from: FROM, to: TO, groupBy: 'day', model: 'gpt-4o-mini' });
    expect(totals.requests).toBe(3); // a1, a2, b4 all counted
    expect(totals.latencyMs.p50).toBeCloseTo(150, 6); // computed over [100,200] only — b4 excluded
  });
});

describe('AnalyticsRepository.bucket — team isolation', () => {
  it('never includes another team\'s spans', async () => {
    await arrange();
    // A second, unrelated team with its own trace/span data.
    const { agent: otherAgent } = await authedAgent(app);
    await otherAgent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            sessionId: 'sess-other',
            name: 'trace-other',
            spans: [
              { spanId: 'o1', name: 'gpt-4o', kind: 'llm', status: 'ok', model: 'gpt-4o', usage: { promptTokens: 999, completionTokens: 999, totalTokens: 1998 }, costUsd: 9.99, startTime: '2026-06-15T10:00:00.000Z', endTime: '2026-06-15T10:00:01.000Z' },
            ],
          },
        ],
      })
      .expect(200);

    const { totals } = await repo.bucket(teamId, { from: FROM, to: TO, groupBy: 'day' });
    expect(totals.requests).toBe(6); // only the arranged team's 6 spans, not the other team's
  });
});
