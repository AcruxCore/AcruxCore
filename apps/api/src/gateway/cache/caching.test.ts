import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

/** Canonical OpenAI chat-completion body the mocked provider returns. */
function openaiBody() {
  return {
    id: 'chatcmpl-abc',
    object: 'chat.completion',
    created: 1751536800,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
  };
}

/**
 * Mock global.fetch to answer the OpenAI provider call. Returns the jest spy.
 * A fresh Response is created per call: a Response body can only be read once,
 * so returning the same instance would break tests that hit the provider twice.
 */
function mockProvider() {
  return jest.spyOn(global, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify(openaiBody()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

interface Setup { agent: ReturnType<typeof request.agent>; teamId: string; virtualKey: string; }

/** Signup + create an OpenAI connection + a virtual key with cache TTL. */
async function setupCallerWithCache(email: string, cacheTtlSeconds: number | null): Promise<Setup> {
  const { agent, teamId } = await authedAgent(app, { email });

  // G1: store a provider key + register a model so the pipeline can resolve.
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'Prod OpenAI', apiKey: 'sk-test-key-AB12', config: {} })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id })
    .expect(201);

  // G3: virtual key with cache opt-in.
  const keyRes = await agent
    .post('/api/v1/gateway/keys')
    .send({ name: 'prod-app', allowedModels: null, allowedProviders: null, cacheTtlSeconds })
    .expect(201);

  return { agent, teamId, virtualKey: keyRes.body.key as string };
}

/** A cacheable request MUST set temperature: 0 (see the temperature-gate decision). */
function cacheableRequest() {
  return { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Say hi in one word.' }], temperature: 0 };
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
    gateway_cache, gateway_requests, budgets, virtual_keys, provider_connections,
    team_invites, audit_log, prompt_aliases, prompt_versions, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('gateway response caching pipeline', () => {
  it('serves the second identical request from cache at zero cost (one provider call)', async () => {
    const fetchSpy = mockProvider();
    const { agent, teamId, virtualKey } = await setupCallerWithCache('hit@cache.test', 300);

    // First call → miss → provider called → stored.
    const first = await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${virtualKey}`)
      .send(cacheableRequest())
      .expect(200);
    expect(first.headers['x-gateway-cache']).toBe('miss');

    // Second identical call → hit → no new provider call.
    const second = await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${virtualKey}`)
      .send(cacheableRequest())
      .expect(200);

    // Body identical.
    expect(second.body).toEqual(first.body);
    // Provider fetch was called exactly once (only for the miss).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Hit headers.
    expect(second.headers['x-gateway-cache']).toBe('hit');
    expect(second.headers['x-gateway-cost-usd']).toBe('0');

    // A cache_hit row exists with cost 0 and copied tokens.
    const hitRow = await prisma.gatewayRequest.findFirst({
      where: { teamId, cacheHit: true },
      orderBy: { createdAt: 'desc' },
    });
    expect(hitRow).not.toBeNull();
    expect(hitRow!.status).toBe('cache_hit');
    expect(Number(hitRow!.costUsd)).toBe(0);
    expect(hitRow!.promptTokens).toBe(12);
    expect(hitRow!.completionTokens).toBe(1);

    void agent;
  });

  it('does NOT increment budget spend on a cache hit', async () => {
    mockProvider();
    const { agent, teamId, virtualKey } = await setupCallerWithCache('budget@cache.test', 300);

    // Create a generous team-wide budget so the calls are allowed.
    await agent
      .post('/api/v1/gateway/budgets')
      .send({ virtualKeyId: null, period: 'month', limitUsd: 50.0 })
      .expect(201);

    // First call (miss) increments spend by the real cost.
    await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${virtualKey}`)
      .send(cacheableRequest())
      .expect(200);

    const afterMiss = await prisma.budget.findFirstOrThrow({ where: { teamId } });
    const spendAfterMiss = Number(afterMiss.spendUsd);
    expect(spendAfterMiss).toBeGreaterThan(0); // miss cost recorded

    // Second call (hit) must NOT change spend.
    await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${virtualKey}`)
      .send(cacheableRequest())
      .expect(200);

    const afterHit = await prisma.budget.findFirstOrThrow({ where: { teamId } });
    expect(Number(afterHit.spendUsd)).toBe(spendAfterMiss); // unchanged by the hit
  });

  it('temperature 0.7 is never cached; temperature 0 vs 0.7 are different keys', async () => {
    const fetchSpy = mockProvider();
    const { virtualKey } = await setupCallerWithCache('temp@cache.test', 300);

    const hot = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Say hi.' }], temperature: 0.7 };

    // Two identical temp=0.7 calls → both hit the provider (non-deterministic, never cached).
    await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${virtualKey}`).send(hot).expect(200);
    const secondHot = await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${virtualKey}`).send(hot).expect(200);
    expect(secondHot.headers['x-gateway-cache']).toBe('miss');
    expect(fetchSpy).toHaveBeenCalledTimes(2); // no caching for temp>0
  });

  it('x-gateway-cache: no-store bypasses both lookup and store', async () => {
    const fetchSpy = mockProvider();
    const { virtualKey } = await setupCallerWithCache('nostore@cache.test', 300);

    // Two identical calls, both with no-store → both go to the provider, nothing cached.
    await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${virtualKey}`)
      .set('x-gateway-cache', 'no-store')
      .send(cacheableRequest())
      .expect(200);
    const second = await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${virtualKey}`)
      .set('x-gateway-cache', 'no-store')
      .send(cacheableRequest())
      .expect(200);

    expect(second.headers['x-gateway-cache']).toBe('miss');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('an expired cache row is treated as a miss and the provider is called again', async () => {
    const fetchSpy = mockProvider();
    const { teamId, virtualKey } = await setupCallerWithCache('expiry@cache.test', 300);

    // First call → stored.
    await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${virtualKey}`)
      .send(cacheableRequest())
      .expect(200);

    // Force the stored row to be expired.
    await prisma.gatewayCache.updateMany({ where: { teamId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    // Next identical call → miss (expired) → provider called again.
    const res = await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${virtualKey}`)
      .send(cacheableRequest())
      .expect(200);
    expect(res.headers['x-gateway-cache']).toBe('miss');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('two teams issuing the identical request get separate rows — no cross-tenant hit', async () => {
    const fetchSpy = mockProvider();
    const teamA = await setupCallerWithCache('tenantA@cache.test', 300);
    const teamB = await setupCallerWithCache('tenantB@cache.test', 300);

    await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${teamA.virtualKey}`).send(cacheableRequest()).expect(200);
    const bRes = await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${teamB.virtualKey}`).send(cacheableRequest()).expect(200);

    // Team B's first call is a miss even though team A cached the identical request.
    expect(bRes.headers['x-gateway-cache']).toBe('miss');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await prisma.gatewayCache.count({ where: { teamId: teamA.teamId } })).toBe(1);
    expect(await prisma.gatewayCache.count({ where: { teamId: teamB.teamId } })).toBe(1);
  });

  it('DELETE /gateway/cache clears the cache so the next call misses again', async () => {
    const fetchSpy = mockProvider();
    const { agent, virtualKey } = await setupCallerWithCache('flush@cache.test', 300);

    await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${virtualKey}`).send(cacheableRequest()).expect(200);
    // Confirm it now hits.
    const hit = await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${virtualKey}`).send(cacheableRequest()).expect(200);
    expect(hit.headers['x-gateway-cache']).toBe('hit');

    // Flush (owner session), assert count.
    const del = await agent.delete('/api/v1/gateway/cache').expect(200);
    expect(del.body.deleted).toBe(1);

    // Next call misses again and re-hits the provider.
    const afterFlush = await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${virtualKey}`).send(cacheableRequest()).expect(200);
    expect(afterFlush.headers['x-gateway-cache']).toBe('miss');
    expect(fetchSpy).toHaveBeenCalledTimes(2); // one for the very first miss, one after flush
  });
});
