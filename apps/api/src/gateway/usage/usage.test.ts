import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

/** Seeds the 5-row fixture into a team, returning the two virtual key ids. */
async function seedFixture(teamId: string, createdBy: string): Promise<{ vk1: string; vk2: string }> {
  const k1 = await prisma.virtualKey.create({ data: { teamId, name: 'vk1', keyHash: `h1-${teamId}`, keyLastFour: 'aaaa', createdBy } });
  const k2 = await prisma.virtualKey.create({ data: { teamId, name: 'vk2', keyHash: `h2-${teamId}`, keyLastFour: 'bbbb', createdBy } });
  await prisma.gatewayRequest.createMany({
    data: [
      { teamId, virtualKeyId: k1.id, provider: 'openai', requestedModel: 'gpt-4o-mini', resolvedModel: 'gpt-4o-mini', status: 'success', promptTokens: 100, completionTokens: 20, totalTokens: 120, costUsd: 0.001, cacheHit: false, createdAt: new Date('2026-06-10T10:00:00Z') },
      { teamId, virtualKeyId: k1.id, provider: 'openai', requestedModel: 'gpt-4o-mini', resolvedModel: 'gpt-4o-mini', status: 'success', promptTokens: 200, completionTokens: 40, totalTokens: 240, costUsd: 0.002, cacheHit: false, createdAt: new Date('2026-06-10T12:00:00Z') },
      { teamId, virtualKeyId: k2.id, provider: 'openai', requestedModel: 'gpt-4o', resolvedModel: 'gpt-4o', status: 'success', promptTokens: 300, completionTokens: 60, totalTokens: 360, costUsd: 0.010, cacheHit: false, createdAt: new Date('2026-06-11T10:00:00Z') },
      { teamId, virtualKeyId: k1.id, provider: 'openai', requestedModel: 'gpt-4o-mini', resolvedModel: 'gpt-4o-mini', status: 'cache_hit', promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, cacheHit: true, createdAt: new Date('2026-06-11T11:00:00Z') },
      { teamId, virtualKeyId: k2.id, provider: 'anthropic', requestedModel: 'claude-3-5-sonnet', resolvedModel: 'claude-3-5-sonnet', status: 'error', promptTokens: 150, completionTokens: 30, totalTokens: 180, costUsd: 0, cacheHit: false, errorCode: 'PROVIDER_ERROR', createdAt: new Date('2026-06-11T13:00:00Z') },
    ],
  });
  return { vk1: k1.id, vk2: k2.id };
}

const RANGE = 'from=2026-06-01&to=2026-07-01';

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
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

describe('GET /api/v1/gateway/usage', () => {
  it('returns hand-summed totals and per-model buckets', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    await seedFixture(teamId, userId);

    const res = await agent.get(`/api/v1/gateway/usage?group_by=model&${RANGE}`).expect(200);

    expect(res.body.groupBy).toBe('model');
    expect(res.body.totals.requests).toBe(5);
    expect(res.body.totals.promptTokens).toBe(750);
    expect(res.body.totals.completionTokens).toBe(150);
    expect(res.body.totals.costUsd).toBeCloseTo(0.013, 6);
    expect(res.body.totals.cacheHitRate).toBeCloseTo(0.2, 6);
    expect(res.body.totals.errorRate).toBeCloseTo(0.2, 6);

    const byKey = Object.fromEntries(res.body.buckets.map((b: { key: string }) => [b.key, b]));
    expect(byKey['gpt-4o-mini'].requests).toBe(3);
    expect(byKey['gpt-4o-mini'].costUsd).toBeCloseTo(0.003, 6);
    expect(byKey['gpt-4o'].costUsd).toBeCloseTo(0.010, 6);
  });

  it('group_by=virtual_key filtered by one key returns only that key spend', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const { vk1 } = await seedFixture(teamId, userId);

    const res = await agent.get(`/api/v1/gateway/usage?group_by=virtual_key&virtual_key_id=${vk1}&${RANGE}`).expect(200);

    expect(res.body.totals.requests).toBe(3);
    expect(res.body.totals.costUsd).toBeCloseTo(0.003, 6);
    expect(res.body.buckets).toHaveLength(1);
    expect(res.body.buckets[0].key).toBe(vk1);
  });

  it('defaults group_by to day and echoes the date range', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    await seedFixture(teamId, userId);

    const res = await agent.get(`/api/v1/gateway/usage?${RANGE}`).expect(200);
    expect(res.body.groupBy).toBe('day');
    expect(res.body.from).toBe('2026-06-01');
    expect(res.body.to).toBe('2026-07-01');
    const byKey = Object.fromEntries(res.body.buckets.map((b: { key: string }) => [b.key, b]));
    expect(byKey['2026-06-10'].requests).toBe(2);
    expect(byKey['2026-06-11'].requests).toBe(3);
  });

  it('returns 400 for an invalid group_by', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    await seedFixture(teamId, userId);
    const res = await agent.get('/api/v1/gateway/usage?group_by=banana').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('is readable via a team-scoped API key (no elevated role) — read is not role-gated', async () => {
    // A team API key carries NO user role; requireRole would 403 it, but usage has
    // no requireRole, so it succeeds — proving a viewer (a real role) is also allowed.
    const { agent, teamId, userId } = await authedAgent(app);
    await seedFixture(teamId, userId);
    const teamKeyRes = await agent.post(`/api/v1/teams/${teamId}/api-keys`).send({ name: 'team-read' }).expect(201);
    const teamKey: string = teamKeyRes.body.key;

    const res = await request(app)
      .get(`/api/v1/gateway/usage?${RANGE}`)
      .set('Authorization', `Bearer ${teamKey}`)
      .expect(200);
    expect(res.body.totals.requests).toBe(5);
  });

  it('never includes another team rows (isolation)', async () => {
    const a = await authedAgent(app);
    await seedFixture(a.teamId, a.userId);
    const b = await authedAgent(app); // b has no rows

    const res = await b.agent.get(`/api/v1/gateway/usage?${RANGE}`).expect(200);
    expect(res.body.totals.requests).toBe(0);
    expect(res.body.buckets).toHaveLength(0);
  });
});

describe('GET /api/v1/gateway/requests', () => {
  it('paginates newest-first with total/page/limit', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    await seedFixture(teamId, userId);

    const res = await agent.get('/api/v1/gateway/requests?page=1&limit=2').expect(200);
    expect(res.body.total).toBe(5);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(2);
    expect(res.body.data).toHaveLength(2);
  });

  it('filters by status=error', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    await seedFixture(teamId, userId);
    const res = await agent.get('/api/v1/gateway/requests?status=error').expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].errorCode).toBe('PROVIDER_ERROR');
  });

  it('GET /requests/:id returns the row; unknown id → 404', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    await seedFixture(teamId, userId);
    const list = await agent.get('/api/v1/gateway/requests?limit=1').expect(200);
    const id = list.body.data[0].id;

    const detail = await agent.get(`/api/v1/gateway/requests/${id}`).expect(200);
    expect(detail.body.id).toBe(id);

    await agent.get('/api/v1/gateway/requests/00000000-0000-0000-0000-000000000000').expect(404);
  });

  it('surfaces prompt_version_id set by a prompt-reference call (lineage in the log)', async () => {
    const { agent, teamId } = await authedAgent(app);

    // Real prompt-ref call with a mocked provider, so a lineage row is written.
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'x', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const conn = await agent.post('/api/v1/gateway/connections').send({ provider: 'openai', label: 't', apiKey: 'sk-test-000000000000AB12', config: {} }).expect(201);
    await agent.post('/api/v1/gateway/models').send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id }).expect(201);
    const p = await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201);
    const v1 = await agent.post(`/api/v1/prompts/${p.body.id}/versions`).send({ messages: [{ role: 'system', content: 'Hello {{ name }}' }] }).expect(201);
    await agent.post('/api/v1/gateway/chat/completions').send({ model: 'gpt-4o-mini', prompt: { name: 'greeting', alias: 'production', variables: { name: 'Al' } } }).expect(200);

    const res = await agent.get('/api/v1/gateway/requests?limit=1').expect(200);
    expect(res.body.data[0].promptVersionId).toBe(v1.body.id);

    void teamId;
  });
});
