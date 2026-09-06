import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { processCell, processFinalize, processJudge, processOptimize } from './index';
import { getFlowProducer, getRedisConnection } from '../queue';
import { authedAgent } from '../../test-utils';

const app = createApp();

type Agent = ReturnType<typeof request.agent>;

/** One `grid` cell as frozen onto `ExperimentRun`. */
interface GridCell {
  cellKey: string;
  variantKind: string;
  promptVersionId: string;
  variantLabel: string;
  model: string;
}

const CANNED_OPENAI = {
  id: 'chatcmpl-int',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi Al!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
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

/** Builds an OpenAI-shaped chat.completion whose assistant content is the optimizer's JSON candidate list. */
function cannedOptimizer(
  candidates: Array<{ messages: Array<{ role: string; content: string }>; rationale: string }>,
): unknown {
  return {
    id: 'chatcmpl-optimize',
    object: 'chat.completion',
    created: 1751536800,
    model: 'gpt-4o-mini',
    choices: [
      { index: 0, message: { role: 'assistant', content: JSON.stringify({ candidates }) }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 40, total_tokens: 90 },
  };
}

function mockFetch(body: unknown): void {
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

/** One-shot fetch mock, queued in call order. */
function queueFetchResponseOnce(body: unknown): void {
  jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

async function createConnection(agent: Agent): Promise<string> {
  const res = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
    .expect(201);
  return res.body.id;
}

async function registerModel(agent: Agent, credentialId: string, name = 'gpt-4o-mini'): Promise<void> {
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: name, upstreamModel: name, credentialId })
    .expect(201);
}

interface ArrangedRun {
  agent: Agent;
  teamId: string;
  userId: string;
  promptId: string;
  datasetId: string;
  experimentId: string;
  runId: string;
  grid: GridCell[];
  exampleIds: string[];
}

/**
 * Arranges a team with a prompt (v1 + v2, v2 on `production`), a 2-example
 * dataset, an experiment naming v1, and one started run — which is `queued`
 * until a test drives the processors.
 */
async function arrangeRun(): Promise<ArrangedRun> {
  const { agent, teamId, userId } = await authedAgent(app);
  const credId = await createConnection(agent);
  await registerModel(agent, credId);

  const prompt = (await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
  const v1 = (
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] })
      .expect(201)
  ).body;
  await agent
    .post(`/api/v1/prompts/${prompt.id}/versions`)
    .send({ messages: [{ role: 'user', content: 'Say hello to {{ name }}' }] })
    .expect(201);
  await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 2 }).expect(200);

  const dataset = (await agent.post('/api/v1/datasets').send({ name: 'greetings' }).expect(201)).body;
  const example1 = (
    await agent
      .post(`/api/v1/datasets/${dataset.id}/examples`)
      .send({ input: { name: 'Al' }, criteria: 'reply in third person' })
      .expect(201)
  ).body;
  const example2 = (
    await agent
      .post(`/api/v1/datasets/${dataset.id}/examples`)
      .send({ input: { name: 'Bo' }, criteria: 'reply politely' })
      .expect(201)
  ).body;

  const experiment = (
    await agent
      .post('/api/v1/experiments')
      .send({ dataset_id: dataset.id, prompt_id: prompt.id, version_ids: [v1.id], models: ['gpt-4o-mini'] })
      .expect(201)
  ).body;

  const runRes = (await agent.post(`/api/v1/experiments/${experiment.id}/runs`).expect(202)).body;
  const runRow = await prisma.experimentRun.findUnique({ where: { id: runRes.run_id } });

  return {
    agent,
    teamId,
    userId,
    promptId: prompt.id,
    datasetId: dataset.id,
    experimentId: experiment.id,
    runId: runRes.run_id,
    grid: runRow!.grid as unknown as GridCell[],
    exampleIds: [example1.id, example2.id],
  };
}

/** Produces + judges every cell of an arranged run, then finalizes it to `succeeded`. */
async function produceAndJudge(run: ArrangedRun): Promise<void> {
  mockFetch(CANNED_OPENAI);
  for (const cell of run.grid) {
    for (const exampleId of run.exampleIds) {
      await processCell({
        teamId: run.teamId,
        runId: run.runId,
        cellKey: cell.cellKey,
        variantKind: cell.variantKind,
        promptVersionId: cell.promptVersionId,
        variantLabel: cell.variantLabel,
        model: cell.model,
        exampleId,
      });
    }
  }

  const results = await prisma.evalResult.findMany({
    where: { experimentRunId: run.runId },
    orderBy: { createdAt: 'asc' },
  });

  jest.restoreAllMocks();
  for (const result of results) {
    queueFetchResponseOnce(cannedJudge({ score: 80, passed: true, reason: 'fine' }));
    await processJudge({ teamId: run.teamId, resultId: result.id });
  }

  await processFinalize({ teamId: run.teamId, runId: run.runId });
}

async function truncateTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    eval_results, prompt_candidates, experiment_runs, experiments,
    dataset_examples, datasets,
    span_payloads, spans, trace_feedback, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys,
    gateway_model_fallbacks, gateway_models, provider_connections,
    prompt_aliases, prompt_versions, prompts,
    audit_log, api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
}

beforeEach(async () => {
  await truncateTables();
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
  // startRun/processOptimize open real ioredis connections via the memoized
  // singletons in ../queue; each test file has its own module registry, so
  // this suite must close its own or Jest hangs.
  await getFlowProducer().close();
  await getRedisConnection().quit();
});

describe('DELETE /api/v1/runs/:id', () => {
  it('removes a finished run and its cells, leaving the experiment and dataset alone', async () => {
    const run = await arrangeRun();
    await produceAndJudge(run);

    expect(await prisma.evalResult.count({ where: { experimentRunId: run.runId } })).toBeGreaterThan(0);

    await run.agent.delete(`/api/v1/runs/${run.runId}`).expect(200);

    expect(await prisma.experimentRun.count({ where: { id: run.runId } })).toBe(0);
    // eval_results cascade from the run.
    expect(await prisma.evalResult.count({ where: { experimentRunId: run.runId } })).toBe(0);
    // The experiment is one level up — a run is one execution of it.
    expect(await prisma.experiment.count({ where: { id: run.experimentId } })).toBe(1);
    expect(await prisma.dataset.count({ where: { id: run.datasetId } })).toBe(1);

    // Gone from the history list, and a re-read 404s.
    const list = await run.agent.get('/api/v1/runs').expect(200);
    expect(list.body.data).toHaveLength(0);
    await run.agent.get(`/api/v1/runs/${run.runId}`).expect(404);
  });

  it('refuses to delete a run that is still queued, and the run survives', async () => {
    const run = await arrangeRun();

    const res = await run.agent.delete(`/api/v1/runs/${run.runId}`).expect(409);
    expect(res.body.error.code).toBe('RUN_IN_FLIGHT');

    expect(await prisma.experimentRun.count({ where: { id: run.runId } })).toBe(1);
  });

  it("keeps an optimizer candidate the run produced (its run link is cleared, not the row)", async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'system', content: 'Answer as {{ name }}' }] })
      .expect(201);
    await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

    const dataset = (await agent.post('/api/v1/datasets').send({ name: 'cases' }).expect(201)).body;
    await agent
      .post(`/api/v1/datasets/${dataset.id}/examples`)
      .send({ input: { name: 'Al' }, criteria: 'reply in third person' })
      .expect(201);

    mockFetch(
      cannedOptimizer([
        { messages: [{ role: 'system', content: 'Answer about {{ name }} in third person' }], rationale: 'third person' },
      ]),
    );
    const optimizeRun = (
      await agent
        .post(`/api/v1/prompts/${prompt.id}/optimize`)
        .send({ dataset_id: dataset.id, models: ['gpt-4o-mini'], draft_count: 1 })
        .expect(202)
    ).body;
    const runRow = await prisma.experimentRun.findUnique({ where: { id: optimizeRun.run_id } });
    await processOptimize({
      teamId,
      userId,
      promptId: prompt.id,
      experimentId: runRow!.experimentId,
      runId: optimizeRun.run_id,
      datasetId: dataset.id,
      models: ['gpt-4o-mini'],
      draftCount: 1,
    });
    jest.restoreAllMocks();

    const candidateId = (await prisma.promptCandidate.findFirst({ where: { experimentRunId: optimizeRun.run_id } }))!.id;

    // Settle the run so it is deletable, then delete it.
    await prisma.experimentRun.update({ where: { id: optimizeRun.run_id }, data: { status: 'failed' } });
    await agent.delete(`/api/v1/runs/${optimizeRun.run_id}`).expect(200);

    // The candidate row is not a cell — a promoted one already produced a real
    // prompt version, so deleting the run must not take it with it.
    const candidate = await prisma.promptCandidate.findUnique({ where: { id: candidateId } });
    expect(candidate).not.toBeNull();
    expect(candidate!.experimentRunId).toBeNull();
  });

  it("returns 404 for another team's run id, never confirming it exists", async () => {
    const run = await arrangeRun();
    await produceAndJudge(run);

    const { agent: other } = await authedAgent(app);
    await other.delete(`/api/v1/runs/${run.runId}`).expect(404);

    expect(await prisma.experimentRun.count({ where: { id: run.runId } })).toBe(1);
  });

  it('returns 401 with no auth', async () => {
    const run = await arrangeRun();
    await request(app).delete(`/api/v1/runs/${run.runId}`).expect(401);
  });
});

describe('DELETE /api/v1/experiments/:id', () => {
  it('removes the experiment and every run under it', async () => {
    const run = await arrangeRun();
    await produceAndJudge(run);

    await run.agent.delete(`/api/v1/experiments/${run.experimentId}`).expect(200);

    expect(await prisma.experiment.count({ where: { id: run.experimentId } })).toBe(0);
    expect(await prisma.experimentRun.count({ where: { experimentId: run.experimentId } })).toBe(0);
    expect(await prisma.evalResult.count({ where: { experimentRunId: run.runId } })).toBe(0);
    // The dataset it swept is a separate resource and stays.
    expect(await prisma.dataset.count({ where: { id: run.datasetId } })).toBe(1);

    await run.agent.get(`/api/v1/experiments/${run.experimentId}`).expect(404);
  });

  it('refuses while one of its runs is still queued, and deletes nothing', async () => {
    const run = await arrangeRun();

    const res = await run.agent.delete(`/api/v1/experiments/${run.experimentId}`).expect(409);
    expect(res.body.error.code).toBe('RUN_IN_FLIGHT');

    expect(await prisma.experiment.count({ where: { id: run.experimentId } })).toBe(1);
    expect(await prisma.experimentRun.count({ where: { id: run.runId } })).toBe(1);
  });

  it("returns 404 for another team's experiment id", async () => {
    const run = await arrangeRun();
    await produceAndJudge(run);

    const { agent: other } = await authedAgent(app);
    await other.delete(`/api/v1/experiments/${run.experimentId}`).expect(404);

    expect(await prisma.experiment.count({ where: { id: run.experimentId } })).toBe(1);
  });
});
