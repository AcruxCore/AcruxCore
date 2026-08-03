import { Prisma } from '@prisma/client';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { __resetRateLimiter } from './rate-limiter';
import { addUserToTeam, authedAgent, type AuthedAgent } from '../../test-utils';
import { drainEmailQueue, getEmailQueue } from '../../email/email.queue';
import { getMemoryTransport } from '../../email/memory.transport';
import type { EmailMessage } from '../../email/email.types';

const app = createApp();

/**
 * One `gpt-4o-mini` call at these token counts costs $0.0000024, so the budget cap
 * is set at $0.0001 — the smallest value `limit_usd`'s Decimal(12,4) can express —
 * and `spend_usd` (Decimal(18,9)) is seeded close to a threshold so a single real
 * gateway call crosses it. Seeding rather than making ~33 calls keeps the test
 * fast while leaving the crossing detection itself entirely real.
 */
const LIMIT_USD = 0.0001;
/** 78% of the cap: one call takes it to 80.4%. */
const JUST_UNDER_WARNING = 0.000078;
/**
 * 98% of the cap: one call's real cost takes it past 100%. Set below
 * `JUST_UNDER_WARNING + 1 more cent than 99.9%` on purpose: the G4/G5
 * reservation (Finding #5) admits this call on its conservative pre-call
 * ESTIMATE (`max_tokens: 1` prompt "hi" ≈ $0.00000105), which is larger than
 * the real per-call cost ($0.0000024) `callGateway` is built around — so the
 * seed must leave headroom for the ESTIMATE, not just the eventual real cost,
 * or the call would be rejected at reservation before it ever reaches 100%.
 */
const JUST_UNDER_LIMIT = 0.000098;

const CANNED_OPENAI = {
  id: 'chatcmpl-budget',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
};

function mockProvider(): void {
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => CANNED_OPENAI,
    text: async () => JSON.stringify(CANNED_OPENAI),
  } as unknown as Response);
}

/** A team with an OpenAI connection, a registered model, and an API key. */
async function setupTeam(): Promise<{
  owner: AuthedAgent;
  apiKey: string;
  model: string;
}> {
  const owner = await authedAgent(app);
  const conn = await owner.agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
    .expect(201);
  const model = 'gpt-4o-mini';
  await owner.agent
    .post('/api/v1/gateway/models')
    .send({ publicName: model, upstreamModel: model, credentialId: conn.body.id })
    .expect(201);
  const key = await owner.agent.post('/api/v1/api-keys').send({ name: 'budget test' }).expect(201);
  return { owner, apiKey: key.body.key as string, model };
}

/** Creates a team-wide monthly budget and returns its id. */
async function createBudget(owner: AuthedAgent, limitUsd = LIMIT_USD): Promise<string> {
  const res = await owner.agent
    .post('/api/v1/gateway/budgets')
    .send({ virtualKeyId: null, period: 'month', limitUsd })
    .expect(201);
  return res.body.id as string;
}

/** Sets a budget's spend directly, to park it just below a threshold. */
async function seedSpend(budgetId: string, spendUsd: number): Promise<void> {
  await prisma.budget.update({
    where: { id: budgetId },
    data: { spendUsd: new Prisma.Decimal(spendUsd) },
  });
}

/**
 * Makes one real gateway call as the given API key.
 *
 * `max_tokens: 1` matches `CANNED_OPENAI`'s real `completion_tokens: 1` so the
 * G4/G5 pre-call reservation estimate (Finding #5) is sized the same as the
 * real cost these threshold tests are built around — without it, the
 * reservation's conservative default completion-token estimate would dwarf
 * this suite's deliberately tiny `LIMIT_USD` and every call would be rejected
 * at the reservation step regardless of seeded spend.
 */
async function callGateway(apiKey: string, model: string, expectStatus = 200): Promise<void> {
  const { default: request } = await import('supertest');
  await request(app)
    .post('/api/v1/gateway/chat/completions')
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 })
    .expect(expectStatus);
}

/** Delivers everything queued and returns the accepted messages. */
async function flush(): Promise<EmailMessage[]> {
  await drainEmailQueue();
  return getMemoryTransport().sent();
}

beforeEach(async () => {
  // Purge before truncating: a leftover job references an `email_log` row that is
  // about to be deleted, and draining it would fail rather than clean up.
  await getEmailQueue().obliterate({ force: true });
  await prisma.$executeRaw`TRUNCATE TABLE
    budgets, gateway_requests, gateway_model_fallbacks, gateway_models,
    virtual_keys, provider_connections, notification_preferences, email_log,
    audit_log, api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;
  __resetRateLimiter();
  getMemoryTransport().reset();
  mockProvider();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('budget alerts', () => {
  it('crossing 80% emails owners and admins exactly once, and never editors or viewers', async () => {
    const { owner, apiKey, model } = await setupTeam();
    const admin = await addUserToTeam(app, owner.teamId, 'admin');
    const editor = await addUserToTeam(app, owner.teamId, 'editor');
    const viewer = await addUserToTeam(app, owner.teamId, 'viewer');
    const budgetId = await createBudget(owner);
    await seedSpend(budgetId, JUST_UNDER_WARNING);

    await callGateway(apiKey, model);

    const messages = await flush();
    expect(messages.map((m) => m.to).sort()).toEqual([admin.email, owner.email].sort());
    expect(messages.map((m) => m.to)).not.toContain(editor.email);
    expect(messages.map((m) => m.to)).not.toContain(viewer.email);
    expect(messages[0].subject).toContain('80%');

    // The alert reports the real post-increment spend, not the seeded value.
    const after = await prisma.budget.findUniqueOrThrow({ where: { id: budgetId } });
    expect(after.spendUsd.toNumber()).toBeGreaterThan(JUST_UNDER_WARNING);
    expect(await prisma.emailLog.count({ where: { type: 'budget_threshold' } })).toBe(2);
  });

  it('two further requests past 80% produce no additional email', async () => {
    const { owner, apiKey, model } = await setupTeam();
    const budgetId = await createBudget(owner);
    await seedSpend(budgetId, JUST_UNDER_WARNING);

    await callGateway(apiKey, model); // crosses
    await callGateway(apiKey, model); // already above
    await callGateway(apiKey, model); // still above

    expect(await flush()).toHaveLength(1);
    expect(await prisma.emailLog.count({ where: { type: 'budget_threshold' } })).toBe(1);
  });

  it('crossing 100% emails the exhausted notice, and the next call still gets its 402', async () => {
    const { owner, apiKey, model } = await setupTeam();
    const budgetId = await createBudget(owner);
    await seedSpend(budgetId, JUST_UNDER_LIMIT);

    await callGateway(apiKey, model);

    const messages = await flush();
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toContain('exhausted');
    expect(await prisma.emailLog.count({ where: { type: 'budget_exhausted' } })).toBe(1);

    // The alert is additive — it does not replace the enforcement.
    await callGateway(apiKey, model, 402);
  });

  it('alerts again in the next period once resets_at has rolled forward', async () => {
    const { owner, apiKey, model } = await setupTeam();
    const budgetId = await createBudget(owner);
    await seedSpend(budgetId, JUST_UNDER_WARNING);

    await callGateway(apiKey, model);
    expect(await flush()).toHaveLength(1);

    // Force the period to elapse. The next call's pre-check lazily zeroes spend and
    // rolls `resets_at` forward, so this call itself must NOT alert (0 → $0.0000024).
    await prisma.budget.update({
      where: { id: budgetId },
      data: { resetsAt: new Date(Date.now() - 60_000) },
    });
    await callGateway(apiKey, model);
    expect(await flush()).toHaveLength(1); // still just the first period's alert

    const rolled = await prisma.budget.findUniqueOrThrow({ where: { id: budgetId } });
    expect(rolled.resetsAt!.getTime()).toBeGreaterThan(Date.now());

    // Now climb to 80% again inside the NEW period. The dedupe key carries
    // `resets_at`, so this is a different event and legitimately alerts.
    await seedSpend(budgetId, JUST_UNDER_WARNING);
    await callGateway(apiKey, model);

    expect(await flush()).toHaveLength(2);
  });

  it('an owner who opted out of budget alerts gets none, while their admin still does', async () => {
    const { owner, apiKey, model } = await setupTeam();
    const admin = await addUserToTeam(app, owner.teamId, 'admin');
    await owner.agent
      .patch('/api/v1/notifications/preferences')
      .send({ category: 'budget_alerts', enabled: false })
      .expect(200);

    const budgetId = await createBudget(owner);
    await seedSpend(budgetId, JUST_UNDER_WARNING);
    await callGateway(apiKey, model);

    expect((await flush()).map((m) => m.to)).toEqual([admin.email]);
  });

  it('two requests racing the same crossing send exactly one alert, not one per request (stale-snapshot regression)', async () => {
    // Regression for the duplicate-alert race: `reconcileBudgets` used to detect
    // a threshold crossing against `preSpendUsd` — a snapshot read once, before
    // EITHER concurrent request's reservation transaction even ran — instead of
    // the accurate before/after pair `incrementSpend` returns for its own atomic
    // update.
    //
    // Note this is deliberately choreographed rather than a bare `Promise.all`:
    // this app's `EmailService.enqueue` already dedupes same-instant concurrent
    // `notify()` calls via a shared BullMQ jobId (see its doc comment), so two
    // truly-simultaneous duplicate detections collapse to one send regardless
    // of this bug — that alone is not an adequate regression test. The REAL
    // exposure is that the FIRST alert can already have been fully delivered
    // (and its job removed) by the time a SECOND request — whose stale
    // `preSpendUsd` snapshot was captured concurrently with the first, before
    // either had reserved — reconciles and (under the bug) wrongly concludes
    // it, too, just caused a fresh crossing: with the job gone, that second
    // `notify()` call is no longer deduped and genuinely sends again. This test
    // freezes the second request's provider response so the first can reserve,
    // call, reconcile, alert, AND have that alert drained (simulating the
    // worker fully processing and removing it) before the second is released.
    const owner = await authedAgent(app);
    const conn = await owner.agent
      .post('/api/v1/gateway/connections')
      .send({ provider: 'openai', label: 'race conn', apiKey: 'sk-test-race0000', config: {} })
      .expect(201);

    // Custom, fully-controlled pricing: zeroing the input price means the
    // pre-call estimator's prompt-token guess (which can differ from the
    // mocked response's real prompt-token count) never affects cost — only
    // completion tokens (pinned to `max_tokens` below) do — so the reservation
    // ESTIMATE and the eventual REAL cost land on exact, chosen dollar amounts.
    await owner.agent
      .post('/api/v1/gateway/models')
      .send({
        publicName: 'race-model',
        upstreamModel: 'race-model',
        credentialId: conn.body.id,
        inputPricePerM: 0,
        outputPricePerM: 1000,
      })
      .expect(201);

    const key = await owner.agent.post('/api/v1/api-keys').send({ name: 'race key' }).expect(201);
    const apiKey = key.body.key as string;

    const budget = await owner.agent
      .post('/api/v1/gateway/budgets')
      .send({ virtualKeyId: null, period: 'total', limitUsd: 1 })
      .expect(201);

    // Seed = $0.10 (10% of the $1 cap). Each call's ESTIMATE (max_tokens: 300 *
    // $1000/1M) is $0.30; each call's REAL cost (mocked completion_tokens: 420 *
    // $1000/1M) is $0.42. Both requests' reservations serialize BEFORE either's
    // provider call (reservation happens early in the pipeline), landing spend
    // at $0.70 (seed + both ESTIMATES) before either reconciles. The first
    // request to reconcile takes real spend from $0.70 to $0.82 — genuinely
    // crossing the 80% ($0.80) threshold, with a deliberate 2-cent margin (not
    // an exact boundary) so floating-point noise in the underlying cost math
    // can never flip the comparison either way. The second request's ACCURATE
    // `before` (from `incrementSpend`, reflecting the first request's
    // already-landed real cost, $0.82) is then already past $0.80, so a
    // correct implementation must NOT alert again. Only a stale snapshot
    // captured before either reservation (the bug, $0.10) would make the
    // second request look, too, like it started below $0.80.
    await seedSpend(budget.body.id, 0.1);

    const RACE_RESPONSE = {
      id: 'chatcmpl-race',
      object: 'chat.completion',
      created: 1751536800,
      model: 'race-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 420, total_tokens: 425 },
    };
    const mockedResponse = { ok: true, status: 200, json: async () => RACE_RESPONSE, text: async () => '' } as unknown as Response;

    // First fetch() call resolves immediately; every call after that is frozen
    // until the test explicitly releases `releaseSecond`, regardless of which
    // HTTP request it belongs to — the two requests' handlers both reach their
    // own `reserveBudgets` (and so their own stale-snapshot read) well before
    // either reaches `fetch()`, so it does not matter which one "wins" the race
    // to go first; only that one is held back while the other finishes.
    let fetchCalls = 0;
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      fetchCalls += 1;
      if (fetchCalls > 1) await secondGate;
      return mockedResponse;
    });

    const { default: request } = await import('supertest');
    const body = { model: 'race-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 300 };
    const call = () =>
      request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${apiKey}`).send(body);

    const reqA = call().expect(200);
    const reqB = call().expect(200);

    // Whichever of the two literally resolves first MUST be the unfrozen one —
    // the frozen one cannot possibly settle before `releaseSecond()` is called
    // below — so `Promise.race` (not "await the one issued first") correctly
    // identifies it regardless of which HTTP request actually won the race to
    // `fetch()` first.
    await Promise.race([reqA, reqB]);
    const firstBatch = await flush(); // drains + REMOVES its BullMQ job (job.remove())
    expect(firstBatch.filter((m) => m.subject.includes('80%'))).toHaveLength(1);

    releaseSecond(); // now let the second request's provider call resolve
    await Promise.all([reqA, reqB]); // both requests have now settled

    // `flush()`'s memory transport is cumulative (everything sent since the
    // last `reset()`), so this second call already includes `firstBatch`'s
    // message too — read it alone rather than concatenating.
    const allSent = await flush();

    const allThresholdMessages = allSent.filter((m) => m.subject.includes('80%'));
    expect(allThresholdMessages).toHaveLength(1);
    expect(await prisma.emailLog.count({ where: { type: 'budget_threshold' } })).toBe(1);
    expect(await prisma.emailLog.count({ where: { type: 'budget_exhausted' } })).toBe(0);

    // Both real costs landed either way: 0.10 + 0.42 + 0.42 = 0.94.
    const after = await prisma.budget.findUniqueOrThrow({ where: { id: budget.body.id } });
    expect(after.spendUsd.toNumber()).toBeCloseTo(0.94, 9);
  });

  it('labels a virtual-key budget with the key name rather than "Team-wide"', async () => {
    const { owner, model } = await setupTeam();
    const keyRes = await owner.agent
      .post('/api/v1/gateway/keys')
      .send({ name: 'ci-pipeline' })
      .expect(201);

    const budget = await owner.agent
      .post('/api/v1/gateway/budgets')
      .send({ virtualKeyId: keyRes.body.id, period: 'month', limitUsd: LIMIT_USD })
      .expect(201);
    await seedSpend(budget.body.id, JUST_UNDER_WARNING);

    await callGateway(keyRes.body.key as string, model);

    const messages = await flush();
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain('ci-pipeline');
  });
});
