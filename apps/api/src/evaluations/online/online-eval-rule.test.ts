import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent, registerTestModel } from '../../test-utils';

const app = createApp();

async function truncateTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    eval_rule_scores, eval_rules,
    span_payloads, spans, traces, team_trace_settings,
    prompt_aliases, prompt_versions, prompts,
    gateway_model_fallbacks, gateway_models, provider_connections,
    audit_log, api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
}

beforeEach(truncateTables);
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
});

describe('eval-rules CRUD', () => {
  it('creates, lists, gets, patches, and deletes a rule; scores cascade on delete', async () => {
    const { agent, teamId } = await authedAgent(app);
    const judgeModel = await registerTestModel(agent);

    const create = await agent
      .post('/api/v1/eval-rules')
      .send({ name: 'quality gate', criteria: 'answers the question asked', sampleRate: 0.5, judgeModel })
      .expect(201);
    expect(create.body.enabled).toBe(true);
    expect(create.body.todayCount).toBe(0);

    const list = await agent.get('/api/v1/eval-rules').expect(200);
    expect(list.body).toHaveLength(1);

    const got = await agent.get(`/api/v1/eval-rules/${create.body.id}`).expect(200);
    expect(got.body.name).toBe('quality gate');

    const patched = await agent
      .patch(`/api/v1/eval-rules/${create.body.id}`)
      .send({ enabled: false, dailyLimit: 10 })
      .expect(200);
    expect(patched.body.enabled).toBe(false);
    expect(patched.body.dailyLimit).toBe(10);

    // A directly-inserted score row must vanish when the rule is deleted (FK cascade).
    // `Trace` requires `teamId` + `startedAt` (no default); `spanId` on
    // EvalRuleScore is a bare scalar with no FK, so reusing the trace's own
    // id as a stand-in span id is fine for this isolated cascade check.
    const trace = await prisma.trace.create({ data: { teamId, startedAt: new Date() } });
    await prisma.evalRuleScore.create({
      data: { teamId, ruleId: create.body.id, traceId: trace.id, spanId: trace.id, score: 40 },
    });

    await agent.delete(`/api/v1/eval-rules/${create.body.id}`).expect(200);
    await agent.get(`/api/v1/eval-rules/${create.body.id}`).expect(404);
    const orphan = await prisma.evalRuleScore.findFirst({ where: { ruleId: create.body.id } });
    expect(orphan).toBeNull();
  });

  it('rejects an out-of-range sampleRate and empty criteria with 400', async () => {
    const { agent } = await authedAgent(app);
    await agent.post('/api/v1/eval-rules').send({ name: 'x', criteria: '', sampleRate: 0.5 }).expect(400);
    await agent.post('/api/v1/eval-rules').send({ name: 'x', criteria: 'ok', sampleRate: 1.5 }).expect(400);
  });

  it('404s a rule id that belongs to another team', async () => {
    const teamA = await authedAgent(app);
    const teamB = await authedAgent(app, { email: `${Date.now()}-b@test.dev` });
    const judgeModel = await registerTestModel(teamA.agent);
    const rule = await teamA.agent.post('/api/v1/eval-rules').send({ name: 'x', criteria: 'ok', judgeModel }).expect(201);
    await teamB.agent.get(`/api/v1/eval-rules/${rule.body.id}`).expect(404);
    await teamB.agent.patch(`/api/v1/eval-rules/${rule.body.id}`).send({ enabled: false }).expect(404);
    await teamB.agent.delete(`/api/v1/eval-rules/${rule.body.id}`).expect(404);
  });
});

describe('judge model + judge prompt validation', () => {
  it('rejects a judgeModel that is not registered for the team', async () => {
    const { agent } = await authedAgent(app);
    await agent
      .post('/api/v1/eval-rules')
      .send({ name: 'x', criteria: 'ok', judgeModel: 'not-a-real-model' })
      .expect(400);
  });

  it('rejects a rule with no judgeModel at all', async () => {
    const { agent } = await authedAgent(app);
    await agent.post('/api/v1/eval-rules').send({ name: 'x', criteria: 'ok' }).expect(400);
  });

  it('rejects a judgePromptId that does not belong to the team', async () => {
    const { agent } = await authedAgent(app);
    const judgeModel = await registerTestModel(agent);
    await agent
      .post('/api/v1/eval-rules')
      .send({ name: 'x', criteria: 'ok', judgeModel, judgePromptId: randomUUID() })
      .expect(400);
  });

  it('rejects the same on update', async () => {
    const { agent } = await authedAgent(app);
    const judgeModel = await registerTestModel(agent);
    const rule = (await agent.post('/api/v1/eval-rules').send({ name: 'x', criteria: 'ok', judgeModel }).expect(201)).body;
    await agent.patch(`/api/v1/eval-rules/${rule.id}`).send({ judgeModel: 'nope' }).expect(400);
    await agent.patch(`/api/v1/eval-rules/${rule.id}`).send({ judgePromptId: randomUUID() }).expect(400);
  });
});

describe('POST /api/v1/eval-rules/:id/preview', () => {
  it('judges the last N matching spans without persisting a score row', async () => {
    const { agent, teamId } = await authedAgent(app);

    // A resolvable gateway connection + model — previewRule's judge() call is real.
    const conn = await agent
      .post('/api/v1/gateway/connections')
      .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
      .expect(201);
    await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id })
      .expect(201);

    const rule = (
      await agent.post('/api/v1/eval-rules').send({ name: 'r', criteria: 'x', judgeModel: 'gpt-4o-mini' }).expect(201)
    ).body;

    // Seed one matching llm span with a captured payload, directly via Prisma.
    const trace = await prisma.trace.create({ data: { teamId, startedAt: new Date() } });
    const span = await prisma.span.create({
      data: { teamId, traceId: trace.id, spanRef: randomUUID(), kind: 'llm', name: 'llm call', startedAt: new Date() },
    });
    // `SpanPayload.teamId` has no default — the task-12 brief's sketch omitted
    // it, which fails Prisma's required-field check at insert time.
    await prisma.spanPayload.create({ data: { spanId: span.id, teamId, output: { text: 'Paris' } } });

    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-preview',
        object: 'chat.completion',
        created: 1751536800,
        model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ score: 88, passed: true, reason: 'preview verdict' }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }),
      text: async () => '',
    } as unknown as Response);

    const res = await agent.post(`/api/v1/eval-rules/${rule.id}/preview`).send({ limit: 10 }).expect(200);

    expect(res.body[0].score).toBe(88);
    expect(await prisma.evalRuleScore.count({ where: { ruleId: rule.id } })).toBe(0); // never persisted
  });

  it('previews using a custom judge prompt when judgePromptId is set', async () => {
    const { agent, teamId } = await authedAgent(app);
    const judgeModel = await registerTestModel(agent);

    const promptRes = await agent.post('/api/v1/prompts').send({ name: 'my custom judge' }).expect(201);
    await agent
      .post(`/api/v1/prompts/${promptRes.body.id}/versions`)
      .send({
        messages: [
          { role: 'system', content: 'CUSTOM JUDGE MARKER — grade against: {{ criteria }}' },
          { role: 'user', content: 'Candidate output: {{ output }}' },
        ],
      })
      .expect(201);

    const rule = (
      await agent
        .post('/api/v1/eval-rules')
        .send({ name: 'r', criteria: 'must mention Paris', judgeModel, judgePromptId: promptRes.body.id })
        .expect(201)
    ).body;
    expect(rule.judgePromptId).toBe(promptRes.body.id);

    const trace = await prisma.trace.create({ data: { teamId, startedAt: new Date() } });
    const span = await prisma.span.create({
      data: { teamId, traceId: trace.id, spanRef: randomUUID(), kind: 'llm', name: 'llm call', startedAt: new Date() },
    });
    await prisma.spanPayload.create({ data: { spanId: span.id, teamId, output: { text: 'Paris' } } });

    let capturedBody: string | undefined;
    jest.spyOn(global, 'fetch').mockImplementationOnce(async (_url, init) => {
      capturedBody = init?.body as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'chatcmpl-custom-judge',
          object: 'chat.completion',
          created: 1751536800,
          model: judgeModel,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify({ score: 100, passed: true, reason: 'mentions Paris' }) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
        text: async () => '',
      } as unknown as Response;
    });

    const res = await agent.post(`/api/v1/eval-rules/${rule.id}/preview`).send({ limit: 10 }).expect(200);

    expect(res.body[0].score).toBe(100);
    // The gateway call the judge made must carry the custom template's content
    // (and its rendered criteria), not the built-in judge's wording.
    expect(capturedBody).toContain('CUSTOM JUDGE MARKER');
    expect(capturedBody).toContain('must mention Paris');
  });
});

describe('POST /api/v1/eval-rules/:id/to-dataset', () => {
  it('builds a dataset from below-threshold scores using the rule\'s own criteria', async () => {
    const { agent, teamId } = await authedAgent(app);
    const judgeModel = await registerTestModel(agent);
    const rule = (
      await agent.post('/api/v1/eval-rules').send({ name: 'r', criteria: 'must be polite', judgeModel }).expect(201)
    ).body;
    const trace = await prisma.trace.create({ data: { teamId, startedAt: new Date() } });
    const span = await prisma.span.create({
      data: { teamId, traceId: trace.id, spanRef: randomUUID(), kind: 'llm', name: 'llm call', startedAt: new Date() },
    });
    await prisma.spanPayload.create({ data: { spanId: span.id, teamId, output: { text: 'rude reply' }, variables: { name: 'Al' } } }); // teamId required, no default
    await prisma.evalRuleScore.create({ data: { teamId, ruleId: rule.id, traceId: trace.id, spanId: span.id, score: 20 } });

    const res = await agent
      .post(`/api/v1/eval-rules/${rule.id}/to-dataset`)
      .send({ datasetName: 'rude-replies', threshold: 50 })
      .expect(201);
    expect(res.body.exampleCount).toBe(1);

    const example = await prisma.datasetExample.findFirst({ where: { datasetId: res.body.id } });
    expect(example?.criteria).toBe('must be polite'); // the rule's criteria, never the score's `reason`
  });
});
