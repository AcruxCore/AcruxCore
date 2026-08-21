import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';
import { processOnlineEval, invalidateRuleCache } from './online-eval.processor';
import { EvalRuleRepository } from './online-eval-rule.repository';
import { JUDGE_MARKER } from './online-eval-rule.service';

const app = createApp();
const repo = new EvalRuleRepository();

const CANNED_OPENAI = {
  id: 'chatcmpl-int',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Paris is the capital of France.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
};

/** Builds an OpenAI-shaped chat.completion whose assistant content is the given verdict, JSON-stringified. */
function cannedJudge(verdict: { score: number; passed: boolean; reason: string }): unknown {
  return {
    id: 'chatcmpl-judge',
    object: 'chat.completion',
    created: 1751536800,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(verdict) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  };
}

/** One-shot fetch mock (queues a single resolved response, unlike `mockFetchOnce`'s persistent `mockResolvedValue`). */
function queueFetchResponseOnce(body: unknown): void {
  jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

function mockFetchOnce(body: unknown, ok = true, status = 200): void {
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response);
}

async function createConnection(agent: ReturnType<typeof request.agent>): Promise<string> {
  const res = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
    .expect(201);
  return res.body.id;
}

async function registerModel(agent: ReturnType<typeof request.agent>, credentialId: string): Promise<void> {
  await agent.post('/api/v1/gateway/models').send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId }).expect(201);
}

/**
 * Sends one gateway completion and returns its resulting span + trace ids.
 *
 * Installs a persistent (`mockResolvedValue`, not `-Once`) fetch mock: call
 * this BEFORE queueing any one-shot judge response with
 * `queueFetchResponseOnce`, never after — a one-shot response queued ahead of
 * this call would get consumed by this completion instead of by the judge
 * call it was meant for, since jest's once-queue is FIFO regardless of a
 * later `mockResolvedValue` default.
 */
async function sendScoredCompletion(agent: ReturnType<typeof request.agent>, teamId: string): Promise<{ traceId: string; spanId: string }> {
  mockFetchOnce(CANNED_OPENAI);
  await agent
    .post('/api/v1/gateway/chat/completions')
    .set('x-capture-payloads', 'true')
    .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'What is the capital of France?' }] })
    .expect(200);
  const trace = await prisma.trace.findFirst({ where: { teamId }, orderBy: { createdAt: 'desc' } });
  const span = await prisma.span.findFirst({ where: { traceId: trace!.id, kind: 'llm' } });
  return { traceId: trace!.id, spanId: span!.id };
}

async function truncateTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    eval_rule_scores, eval_rules,
    span_payloads, spans, trace_feedback, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys,
    gateway_model_fallbacks, gateway_models, provider_connections,
    prompt_aliases, prompt_versions, prompts,
    email_log, audit_log, api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
}

beforeEach(async () => {
  await truncateTables();
  invalidateRuleCache();
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
});

describe('processOnlineEval', () => {
  it('scores a matching span end to end and the trace becomes findable by minScore', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);
    const rule = (
      await agent.post('/api/v1/eval-rules').send({ name: 'geo-accuracy', criteria: 'names the correct capital city', sampleRate: 1, judgeModel: 'gpt-4o-mini' }).expect(201)
    ).body;

    const { traceId, spanId } = await sendScoredCompletion(agent, teamId);

    queueFetchResponseOnce(cannedJudge({ score: 95, passed: true, reason: 'correct capital named' }));
    invalidateRuleCache();
    await processOnlineEval({ teamId, traceId, spanId, spanKind: 'llm' });

    const score = await prisma.evalRuleScore.findFirst({ where: { ruleId: rule.id, spanId } });
    expect(score?.score).toBe(95);
    expect(score?.judgeTraceId).toBeTruthy();
    expect(score?.judgeTraceId).not.toBe(traceId);

    const traces = await agent.get(`/api/v1/traces?min_score=90&rule_id=${rule.id}`).expect(200);
    expect(traces.body.data.some((t: { id: string }) => t.id === traceId)).toBe(true);
  });

  it("never scores the judge's own call — the loop guard", async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);
    const rule = (await agent.post('/api/v1/eval-rules').send({ name: 'rule', criteria: 'is helpful', sampleRate: 1, judgeModel: 'gpt-4o-mini' }).expect(201)).body;

    const { traceId, spanId } = await sendScoredCompletion(agent, teamId);
    queueFetchResponseOnce(cannedJudge({ score: 80, passed: true, reason: 'fine' }));
    invalidateRuleCache();
    await processOnlineEval({ teamId, traceId, spanId, spanKind: 'llm' });

    const judgeScore = await prisma.evalRuleScore.findFirst({ where: { ruleId: rule.id } });
    const judgeTraceId = judgeScore!.judgeTraceId!;
    const judgeSpan = await prisma.span.findFirst({ where: { traceId: judgeTraceId, kind: 'llm' } });
    expect(judgeSpan).not.toBeNull();

    // Feed the judge's own span back into the processor exactly as the trigger would.
    await processOnlineEval({ teamId, traceId: judgeTraceId, spanId: judgeSpan!.id, spanKind: 'llm' });

    const allScores = await prisma.evalRuleScore.findMany({ where: { ruleId: rule.id } });
    expect(allScores).toHaveLength(1); // still just the original — the judge call scored nothing
  });

  // The full sequence above fully awaits every step, so by the time it feeds
  // the judge's own span back in, the original score row already exists with
  // `judgeTraceId` pointing at that span's trace — guard #2 (`isJudgeTrace`)
  // is independently true there, on top of guard #1's own metadata stamp. In
  // real production, `enqueueOnlineEval` fires for the judge's own span WHILE
  // `judge()` is still running — before the original score row (and its
  // `judgeTraceId`) exists — so guard #2 can legitimately be empty exactly
  // when that job runs, leaving guard #1 as the only thing standing between a
  // single dropped metadata stamp and an infinite loop. The two tests below
  // isolate each guard so that removing either ONE, alone, fails its own test.
  it('never scores a span carrying the JUDGE_MARKER stamp, even with no EvalRuleScore row anywhere — guard #1 alone', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);
    await agent.post('/api/v1/eval-rules').send({ name: 'r', criteria: 'x', sampleRate: 1, judgeModel: 'gpt-4o-mini' }).expect(201);
    invalidateRuleCache();

    // A fresh trace with no EvalRuleScore row anywhere in the DB — guard #2
    // (`isJudgeTrace`) has nothing to find here, so only guard #1 (the
    // metadata stamp check) can be what stops this span from being scored.
    const trace = await prisma.trace.create({ data: { teamId, startedAt: new Date() } });
    const span = await prisma.span.create({
      data: {
        teamId,
        traceId: trace.id,
        spanRef: randomUUID(),
        kind: 'llm',
        name: 'judge-call',
        startedAt: new Date(),
        metadata: { [JUDGE_MARKER]: true },
      },
    });

    await processOnlineEval({ teamId, traceId: trace.id, spanId: span.id, spanKind: 'llm' });
    expect(await prisma.evalRuleScore.count()).toBe(0);
  });

  it('does not score a later span on an already-recorded judge trace, even with no marker on that span — guard #2 alone', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);
    const rule = (await agent.post('/api/v1/eval-rules').send({ name: 'r', criteria: 'x', sampleRate: 1, judgeModel: 'gpt-4o-mini' }).expect(201)).body;
    invalidateRuleCache();

    // Simulates: this trace was already recorded as a judge trace by an
    // earlier verdict (on some other span this test doesn't care about), but
    // the NEW span below — on that same trace — never got its own
    // JUDGE_MARKER metadata stamped (guard #1 has nothing to catch it).
    const priorJudgeTraceId = randomUUID();
    await repo.upsertScore({
      teamId,
      ruleId: rule.id,
      traceId: randomUUID(), // the span that earlier verdict actually scored — unrelated to this test
      spanId: randomUUID(),
      score: 88,
      passed: true,
      reason: 'earlier verdict',
      judgeTraceId: priorJudgeTraceId,
      costUsd: null,
    });

    const trace = await prisma.trace.create({ data: { id: priorJudgeTraceId, teamId, startedAt: new Date() } });
    const span = await prisma.span.create({
      data: { teamId, traceId: trace.id, spanRef: randomUUID(), kind: 'llm', name: 'later-span', startedAt: new Date() },
    });

    await processOnlineEval({ teamId, traceId: trace.id, spanId: span.id, spanKind: 'llm' });
    expect(await prisma.evalRuleScore.findFirst({ where: { ruleId: rule.id, spanId: span.id } })).toBeNull();
  });

  it("a rule filtered to one prompt does not score another prompt's span", async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);
    const promptA = (await agent.post('/api/v1/prompts').send({ name: 'a' }).expect(201)).body;
    const rule = (
      await agent
        .post('/api/v1/eval-rules')
        .send({ name: 'a-only', criteria: 'x', sampleRate: 1, judgeModel: 'gpt-4o-mini', filter: { promptId: promptA.id } })
        .expect(201)
    ).body;

    const { traceId, spanId } = await sendScoredCompletion(agent, teamId); // no promptId on this span
    invalidateRuleCache();
    await processOnlineEval({ teamId, traceId, spanId, spanKind: 'llm' });

    const score = await prisma.evalRuleScore.findFirst({ where: { ruleId: rule.id, spanId } });
    expect(score).toBeNull();
  });

  it('sampling: a draw above sampleRate skips scoring, a draw below it scores', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);
    const rule = (await agent.post('/api/v1/eval-rules').send({ name: 'r', criteria: 'x', sampleRate: 0.01, judgeModel: 'gpt-4o-mini' }).expect(201)).body;
    invalidateRuleCache();

    const jestRandom = jest.spyOn(Math, 'random').mockReturnValue(0.5); // 0.5 >= 0.01 → skipped
    const { traceId, spanId } = await sendScoredCompletion(agent, teamId);
    await processOnlineEval({ teamId, traceId, spanId, spanKind: 'llm' });
    expect(await prisma.evalRuleScore.findFirst({ where: { ruleId: rule.id, spanId } })).toBeNull();

    jestRandom.mockReturnValue(0.0); // 0.0 < 0.01 → scored
    // Queued AFTER sendScoredCompletion, not before: a one-shot mock queued
    // ahead of that call would be consumed by the completion itself (its own
    // persistent mockFetchOnce only sets the *default*, it never clears a
    // pending -Once value), leaving the judge call with no queued verdict.
    const second = await sendScoredCompletion(agent, teamId);
    queueFetchResponseOnce(cannedJudge({ score: 70, passed: true, reason: 'ok' }));
    await processOnlineEval({ teamId, traceId: second.traceId, spanId: second.spanId, spanKind: 'llm' });
    const secondScore = await prisma.evalRuleScore.findFirst({ where: { ruleId: rule.id, spanId: second.spanId } });
    expect(secondScore).not.toBeNull();
    expect(secondScore?.score).toBe(70);
  });

  it('stops judging once the daily limit is hit', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);
    const rule = (
      await agent
        .post('/api/v1/eval-rules')
        .send({ name: 'capped', criteria: 'x', sampleRate: 1, judgeModel: 'gpt-4o-mini', dailyLimit: 1 })
        .expect(201)
    ).body;
    invalidateRuleCache();

    const first = await sendScoredCompletion(agent, teamId);
    queueFetchResponseOnce(cannedJudge({ score: 50, passed: true, reason: 'ok' }));
    await processOnlineEval({ teamId, traceId: first.traceId, spanId: first.spanId, spanKind: 'llm' });

    const second = await sendScoredCompletion(agent, teamId);
    await processOnlineEval({ teamId, traceId: second.traceId, spanId: second.spanId, spanKind: 'llm' });

    const scores = await prisma.evalRuleScore.findMany({ where: { ruleId: rule.id } });
    expect(scores).toHaveLength(1);
  });

  it('writes a null-score row explaining itself when payload capture is off', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);
    const rule = (await agent.post('/api/v1/eval-rules').send({ name: 'r', criteria: 'x', sampleRate: 1, judgeModel: 'gpt-4o-mini' }).expect(201)).body;
    invalidateRuleCache();

    mockFetchOnce(CANNED_OPENAI);
    await agent
      .post('/api/v1/gateway/chat/completions')
      // no x-capture-payloads header — capture defaults per team setting, force it off:
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
      .expect(200);
    await prisma.teamTraceSettings.upsert({
      where: { teamId },
      create: { teamId, capturePayloads: false },
      update: { capturePayloads: false },
    });
    const trace = await prisma.trace.findFirst({ where: { teamId }, orderBy: { createdAt: 'desc' } });
    const span = await prisma.span.findFirst({ where: { traceId: trace!.id, kind: 'llm' } });
    await prisma.spanPayload.deleteMany({ where: { spanId: span!.id } }); // simulate capture-off for this specific span

    await processOnlineEval({ teamId, traceId: trace!.id, spanId: span!.id, spanKind: 'llm' });

    const score = await prisma.evalRuleScore.findFirst({ where: { ruleId: rule.id, spanId: span!.id } });
    expect(score?.score).toBeNull();
    expect(score?.reason).toBe('not scored: payload capture is off for this team');
  });

  it('is idempotent: running the same job twice yields one row, not two', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);
    const rule = (await agent.post('/api/v1/eval-rules').send({ name: 'r', criteria: 'x', sampleRate: 1, judgeModel: 'gpt-4o-mini' }).expect(201)).body;
    invalidateRuleCache();

    const { traceId, spanId } = await sendScoredCompletion(agent, teamId);
    queueFetchResponseOnce(cannedJudge({ score: 60, passed: true, reason: 'ok' }));
    await processOnlineEval({ teamId, traceId, spanId, spanKind: 'llm' });
    queueFetchResponseOnce(cannedJudge({ score: 60, passed: true, reason: 'ok' }));
    await processOnlineEval({ teamId, traceId, spanId, spanKind: 'llm' });

    const scores = await prisma.evalRuleScore.findMany({ where: { ruleId: rule.id, spanId } });
    expect(scores).toHaveLength(1);
  });

  it('a 402 from the judge disables the rule and notifies once', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);
    const rule = (await agent.post('/api/v1/eval-rules').send({ name: 'r', criteria: 'x', sampleRate: 1, judgeModel: 'gpt-4o-mini' }).expect(201)).body;

    // Capture the original completion BEFORE the budget exists: a $0 budget in
    // place already would 402 this call too (it goes through the exact same
    // gateway budget reservation), never reaching processOnlineEval at all.
    const { traceId, spanId } = await sendScoredCompletion(agent, teamId);

    // limit_usd is Decimal(12,4) — 0.0000001 rounds to 0.0000 once stored, so
    // the team-wide budget's real cap becomes exactly $0. The very next
    // gateway call (the judge's own gateway.complete()) will fail its
    // pre-call reservation check (spend_usd + estimate <= limit_usd) and
    // throw PaymentRequiredError before ever reaching the mocked provider —
    // deterministic regardless of the judge prompt's actual token cost.
    await agent.post('/api/v1/gateway/budgets').send({ period: 'day', limitUsd: 0.0000001 }).expect(201);
    invalidateRuleCache();

    await processOnlineEval({ teamId, traceId, spanId, spanKind: 'llm' });

    const disabled = await prisma.evalRule.findUnique({ where: { id: rule.id } });
    expect(disabled?.enabled).toBe(false);
    // The "notifies once" half of this test's name — sendDisabledAlert's
    // notify() writes an `email_log` row synchronously (before the delivery
    // job is ever drained), so this needs no queue drain to observe.
    expect(await prisma.emailLog.count({ where: { teamId, type: 'eval_rule_alert' } })).toBe(1);
  });

  it('a tool-kind span is a no-op', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);
    await agent.post('/api/v1/eval-rules').send({ name: 'r', criteria: 'x', sampleRate: 1, judgeModel: 'gpt-4o-mini' }).expect(201);
    invalidateRuleCache();

    const trace = await prisma.trace.create({ data: { teamId, startedAt: new Date() } });
    const span = await prisma.span.create({
      data: { teamId, traceId: trace.id, spanRef: randomUUID(), kind: 'tool', name: 'search', startedAt: new Date() },
    });

    await processOnlineEval({ teamId, traceId: trace.id, spanId: span.id, spanKind: 'tool' });
    expect(await prisma.evalRuleScore.count()).toBe(0);
  });
});
