import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { __resetRateLimiter } from './rate-limiter';
import { authHeaders, resetAuthTables, signupTestUser, type TestAuthContext } from '../../test-utils';

const app = createApp();

async function truncateTables(): Promise<void> {
  // Delegates to the shared reset rather than keeping a local delete chain: every
  // such chain omitted a table that references `users` or `teams` (`audit_log`,
  // `tools`, ...), which passed alone and FK-violated in a full run the moment an
  // earlier suite left a row behind. `TRUNCATE ... CASCADE` reaches the
  // dependants automatically, so it needs no edit when a new domain lands.
  await resetAuthTables();
}

/**
 * Replaces a user's roles in their own (session-active) team. Used to exercise
 * RBAC: session auth scopes req.teamId to the signup team, so we change the
 * caller's role there rather than adding a second user to another team (whose
 * session would point at their own personal team). Mirrors completions.test.ts.
 */
async function setRole(userId: string, teamId: string, role: 'owner' | 'admin' | 'editor' | 'viewer') {
  await prisma.teamMember.update({ where: { userId_teamId: { userId, teamId } }, data: { role } });
}

beforeEach(async () => {
  await truncateTables();
  __resetRateLimiter();
});

afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
});

describe('POST /api/v1/gateway/budgets', () => {
  it('owner creates a team-wide monthly budget → 201 with computed resetsAt', async () => {
    const ctx = await signupTestUser(app);

    const res = await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ctx))
      .send({ virtualKeyId: null, period: 'month', limitUsd: 50 })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.virtualKeyId).toBeNull();
    expect(res.body.period).toBe('month');
    expect(res.body.limitUsd).toBe(50);
    expect(res.body.spendUsd).toBe(0);
    expect(res.body.resetsAt).not.toBeNull(); // month → start of next month

    const row = await prisma.budget.findUnique({ where: { id: res.body.id } });
    expect(row!.limitUsd.toNumber()).toBe(50);
    expect(row!.spendUsd.toNumber()).toBe(0);
  });

  it("a 'total' budget has null resetsAt", async () => {
    const ctx = await signupTestUser(app);
    const res = await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ctx))
      .send({ virtualKeyId: null, period: 'total', limitUsd: 0.01 })
      .expect(201);
    expect(res.body.resetsAt).toBeNull();
  });

  it('duplicate scope+period → 409 BUDGET_EXISTS', async () => {
    const ctx = await signupTestUser(app);
    await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ctx))
      .send({ virtualKeyId: null, period: 'month', limitUsd: 10 })
      .expect(201);

    const dup = await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ctx))
      .send({ virtualKeyId: null, period: 'month', limitUsd: 20 })
      .expect(409);
    expect(dup.body.error.code).toBe('BUDGET_EXISTS');
  });

  it('editor cannot create a budget → 403', async () => {
    const ctx = await signupTestUser(app);
    await setRole(ctx.userId, ctx.teamId, 'editor');

    await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ctx))
      .send({ virtualKeyId: null, period: 'month', limitUsd: 10 })
      .expect(403);
  });

  it('rejects a non-positive limit → 400', async () => {
    const ctx = await signupTestUser(app);
    await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ctx))
      .send({ virtualKeyId: null, period: 'month', limitUsd: 0 })
      .expect(400);
  });
});

describe('GET /api/v1/gateway/budgets', () => {
  it('any role (viewer) can list budgets with live spend', async () => {
    const ctx = await signupTestUser(app);
    await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ctx))
      .send({ virtualKeyId: null, period: 'month', limitUsd: 25 })
      .expect(201);

    // Downgrade to viewer, then list — any role may read budgets.
    await setRole(ctx.userId, ctx.teamId, 'viewer');
    const res = await request(app).get('/api/v1/gateway/budgets').set(authHeaders(ctx)).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].spendUsd).toBe(0);
  });
});

describe('PATCH /api/v1/gateway/budgets/:id', () => {
  it('owner updates the limit → 200 and DB reflects it', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ctx))
      .send({ virtualKeyId: null, period: 'month', limitUsd: 10 })
      .expect(201);

    const res = await request(app)
      .patch(`/api/v1/gateway/budgets/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ limitUsd: 99 })
      .expect(200);
    expect(res.body.limitUsd).toBe(99);

    const row = await prisma.budget.findUnique({ where: { id: created.body.id } });
    expect(row!.limitUsd.toNumber()).toBe(99);
  });

  it('editor cannot update → 403', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ctx))
      .send({ virtualKeyId: null, period: 'month', limitUsd: 10 })
      .expect(201);
    await setRole(ctx.userId, ctx.teamId, 'editor');

    await request(app)
      .patch(`/api/v1/gateway/budgets/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ limitUsd: 5 })
      .expect(403);
  });
});

describe('DELETE /api/v1/gateway/budgets/:id', () => {
  it('owner deletes a budget → 204 and row is gone', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ctx))
      .send({ virtualKeyId: null, period: 'total', limitUsd: 1 })
      .expect(201);

    await request(app).delete(`/api/v1/gateway/budgets/${created.body.id}`).set(authHeaders(ctx)).expect(204);
    expect(await prisma.budget.findUnique({ where: { id: created.body.id } })).toBeNull();
  });
});

// ── Enforcement (pipeline stages 4a/4b) ──────────────────────────────────────
//
// Provider HTTP is the ONLY thing mocked (CLAUDE.md). We stub global.fetch to
// return a canned OpenAI chat.completion with a small, known usage so cost is
// deterministic. gpt-4o-mini pricing: input $0.15 / 1M, output $0.60 / 1M.
//   usage {10,10} → 10/1e6*0.15 + 10/1e6*0.60 = 0.0000075 USD per call.

const OPENAI_BODY = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
};
const COST_PER_CALL = 0.0000075; // 10 in * $0.15/1M + 10 out * $0.60/1M

/**
 * Mocks the provider fetch to return a fresh Response per call (Response bodies
 * are single-read; a fresh instance each call keeps multi-call tests safe).
 */
function mockProvider(body: unknown = OPENAI_BODY, status = 200): jest.SpyInstance {
  return jest.spyOn(global, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }) as unknown as Response,
  );
}

/** Stores an OpenAI credential and registers the models the budget tests call. */
async function storeOpenAiConnection(ctx: TestAuthContext) {
  const conn = await request(app)
    .post('/api/v1/gateway/connections')
    .set(authHeaders(ctx))
    .send({ provider: 'openai', label: 'test-openai', apiKey: 'sk-test-fake' })
    .expect(201);
  for (const name of ['gpt-4o-mini', 'gpt-4o-experimental']) {
    await request(app)
      .post('/api/v1/gateway/models')
      .set(authHeaders(ctx))
      .send({ publicName: name, upstreamModel: name, credentialId: conn.body.id })
      .expect(201);
  }
  return conn;
}

/**
 * Creates a virtual key (G3); returns id + plaintext token (shown once).
 * Rate-limit fields are only sent when explicitly overridden — the create schema
 * treats maxRpm/maxTpm/cacheTtlSeconds as optional (non-nullable), so passing null
 * would 400.
 */
async function createVirtualKey(ctx: TestAuthContext, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/v1/gateway/keys')
    .set(authHeaders(ctx))
    .send({ name: 'app', ...overrides })
    .expect(201);
  return res.body as { id: string; key: string };
}

const CHAT_BODY = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Say hi.' }], max_tokens: 20 };

afterEach(() => jest.restoreAllMocks());

describe('budget enforcement (pipeline stage 4b)', () => {
  it("team-wide 'total' $0.01 cap: a call with headroom for its RESERVED estimate succeeds and reconciles down to the real cost; the next call is rejected because reserving its estimate would exceed the cap", async () => {
    const ctx = await signupTestUser(app);
    await storeOpenAiConnection(ctx);
    const vk = await createVirtualKey(ctx);
    const budget = await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ctx))
      .send({ virtualKeyId: null, period: 'total', limitUsd: 0.01 })
      .expect(201);

    mockProvider();

    // G4/G5 (Finding #5) reserves a conservative pre-call ESTIMATE, not the
    // eventual real cost: CHAT_BODY's max_tokens: 20 plus the 5-token prompt
    // ("Say hi.") prices out to 0.00001275 — bigger than COST_PER_CALL's real
    // 0.0000075, since the real completion only used 10 tokens. Seed spend so
    // exactly one more call's ESTIMATE (not its real cost) fits under the cap.
    const ESTIMATE_PER_CALL = 0.00001275; // 5 prompt tokens * $0.15/1M + 20 max_tokens * $0.60/1M
    const seedSpend = 0.01 - ESTIMATE_PER_CALL;
    await prisma.budget.update({ where: { id: budget.body.id }, data: { spendUsd: seedSpend.toFixed(9) } });

    // Reservation succeeds (seed + estimate <= limit) → the real call proceeds.
    await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${vk.key}`).send(CHAT_BODY).expect(200);

    const afterOne = await prisma.budget.findUnique({ where: { id: budget.body.id } });
    // Reconciled down to the real cost — the estimate's overshoot is credited
    // back, so spend stays comfortably under the cap rather than crossing it.
    expect(afterOne!.spendUsd.toNumber()).toBeCloseTo(seedSpend + COST_PER_CALL, 9);
    expect(afterOne!.spendUsd.toNumber()).toBeLessThan(0.01);

    // Actual spend is still under the cap, but reserving the NEXT call's
    // estimate would exceed it — the fix guards on the reservation headroom,
    // not on spend already committed, which is exactly what closes the race.
    const over = await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${vk.key}`)
      .send(CHAT_BODY)
      .expect(402);
    expect(over.body.error.code).toBe('BUDGET_EXCEEDED');
    expect(over.body.error.message).toMatch(/team/i);

    // Rejected call must NOT have added spend.
    const finalBudget = await prisma.budget.findUnique({ where: { id: budget.body.id } });
    expect(finalBudget!.spendUsd.toNumber()).toBeCloseTo(afterOne!.spendUsd.toNumber(), 9);
  });

  it('concurrency: N requests racing a budget with headroom for exactly one only let one succeed', async () => {
    const ctx = await signupTestUser(app);
    await storeOpenAiConnection(ctx);
    const vk = await createVirtualKey(ctx);

    // `limit_usd` is a Decimal(12,4) — $0.0001 is the smallest value it can
    // express — so the cap itself can't be sized to exactly one estimate the
    // way the single-request tests above do. Instead, size the CALL so its
    // reservation ESTIMATE is just under the cap but more than half of it:
    // one fits, two never can, regardless of how many race in. The mocked
    // usage is chosen so the REAL cost equals the estimate exactly (unlike
    // the single-request tests above, which deliberately use a real cost
    // smaller than the estimate) — otherwise a fast-finishing winner would
    // reconcile its reservation down and free enough headroom for a second
    // request to win too, which would defeat the point of this test.
    const BIG_BODY = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Say hi.' }], max_tokens: 100 };
    const ESTIMATE_PER_CALL = 0.00006075; // 5 prompt tokens * $0.15/1M + 100 max_tokens * $0.60/1M
    const LIMIT = 0.0001;
    expect(ESTIMATE_PER_CALL).toBeLessThanOrEqual(LIMIT);
    expect(2 * ESTIMATE_PER_CALL).toBeGreaterThan(LIMIT);

    await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ctx))
      .send({ virtualKeyId: null, period: 'total', limitUsd: LIMIT })
      .expect(201);

    mockProvider({
      ...OPENAI_BODY,
      usage: { prompt_tokens: 5, completion_tokens: 100, total_tokens: 105 },
    });

    // Before Finding #5's fix, `precheckBudgets` read spend, decided, then
    // incremented only after the (mocked) upstream call returned — so N
    // concurrent requests could all read "under budget" and all succeed. The
    // atomic conditional-UPDATE reservation in `reserveBudgets` now serializes
    // on the budget row, so only as many requests as actually fit can ever win,
    // no matter how many race in at once.
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        request(app)
          .post('/api/v1/gateway/chat/completions')
          .set('Authorization', `Bearer ${vk.key}`)
          .send(BIG_BODY),
      ),
    );

    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 402)).toHaveLength(N - 1);
  });

  it('per-key budget halts only that key; other keys are unaffected', async () => {
    const ctx = await signupTestUser(app);
    await storeOpenAiConnection(ctx);
    const vkA = await createVirtualKey(ctx, { name: 'A' });
    const vkB = await createVirtualKey(ctx, { name: 'B' });

    // Cap key A only, already at its limit.
    const budA = await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ctx))
      .send({ virtualKeyId: vkA.id, period: 'total', limitUsd: 0.001 })
      .expect(201);
    await prisma.budget.update({ where: { id: budA.body.id }, data: { spendUsd: '0.001' } });

    mockProvider();

    await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${vkA.key}`).send(CHAT_BODY).expect(402);
    await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${vkB.key}`).send(CHAT_BODY).expect(200);
  });

  it('resets_at in the past → spend resets on the next call, so it succeeds', async () => {
    const ctx = await signupTestUser(app);
    await storeOpenAiConnection(ctx);
    const vk = await createVirtualKey(ctx);
    const budget = await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ctx))
      .send({ virtualKeyId: null, period: 'day', limitUsd: 0.001 })
      .expect(201);

    // Push it over the cap but with resets_at in the past → lazy reset zeros it.
    await prisma.budget.update({
      where: { id: budget.body.id },
      data: { spendUsd: '0.01', resetsAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    mockProvider();

    await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${vk.key}`).send(CHAT_BODY).expect(200);

    const after = await prisma.budget.findUnique({ where: { id: budget.body.id } });
    expect(after!.spendUsd.toNumber()).toBeCloseTo(COST_PER_CALL, 9); // reset to 0, then this call added cost
    expect(after!.resetsAt!.getTime()).toBeGreaterThan(Date.now());   // rolled forward
  });

  it('atomicity: after a successful call, BOTH the gateway_requests row and the spend increment persist together', async () => {
    const ctx = await signupTestUser(app);
    await storeOpenAiConnection(ctx);
    const vk = await createVirtualKey(ctx);
    const budget = await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ctx))
      .send({ virtualKeyId: null, period: 'month', limitUsd: 100 })
      .expect(201);

    mockProvider();
    await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${vk.key}`).send(CHAT_BODY).expect(200);

    const rows = await prisma.gatewayRequest.findMany({ where: { teamId: ctx.teamId } });
    const bud = await prisma.budget.findUnique({ where: { id: budget.body.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].costUsd!.toNumber()).toBeCloseTo(COST_PER_CALL, 9);
    expect(bud!.spendUsd.toNumber()).toBeCloseTo(COST_PER_CALL, 9); // same amount, same tx
  });

  it('unknown-cost call increments spend by 0', async () => {
    const ctx = await signupTestUser(app);
    await storeOpenAiConnection(ctx);
    const vk = await createVirtualKey(ctx);
    const budget = await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ctx))
      .send({ virtualKeyId: null, period: 'month', limitUsd: 100 })
      .expect(201);

    // Model absent from the pricing registry → computeCost returns null.
    mockProvider({ ...OPENAI_BODY, model: 'gpt-4o-experimental' });
    await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${vk.key}`)
      .send({ ...CHAT_BODY, model: 'gpt-4o-experimental' })
      .expect(200);

    const bud = await prisma.budget.findUnique({ where: { id: budget.body.id } });
    expect(bud!.spendUsd.toNumber()).toBe(0); // null cost → +0
  });
});

describe('rate-limit enforcement (pipeline stage 4a)', () => {
  it('virtual key maxRpm=1 → 2nd call within 60s → 429 RATE_LIMITED with Retry-After', async () => {
    const ctx = await signupTestUser(app);
    await storeOpenAiConnection(ctx);
    const vk = await createVirtualKey(ctx, { maxRpm: 1 });

    mockProvider();
    const ok = await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${vk.key}`).send(CHAT_BODY).expect(200);
    expect(ok.headers['x-gateway-ratelimit-remaining']).toBe('0');

    const limited = await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${vk.key}`)
      .send(CHAT_BODY)
      .expect(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
