import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { processCell, processFinalize, processJudge, RunsRepository } from './index';
import { getFlowProducer, getRedisConnection } from '../queue';
import { authedAgent } from '../../test-utils';

const app = createApp();

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

interface GridCell {
  cellKey: string;
  variantKind: string;
  promptVersionId: string;
  variantLabel: string;
  model: string;
}

type Agent = ReturnType<typeof request.agent>;

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
  email: string;
  promptId: string;
  datasetId: string;
  experimentId: string;
  runId: string;
  grid: GridCell[];
  exampleIds: string[];
}

/**
 * Arranges one team with a prompt (v1 + v2, v2 promoted to `production`), a
 * 2-example dataset, an experiment naming v1 explicitly and no `alias` — so
 * `resolveGrid` resolves the baseline to the prompt's latest committed
 * version (v2 here) and adds it back as a second variant, labeled `v2` — and
 * a started run. The run has produced nothing yet; each test drives the
 * processors it needs.
 */
async function arrangeRun(opts: { experimentName?: string } = {}): Promise<ArrangedRun> {
  const { agent, teamId, userId, email } = await authedAgent(app);
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
      .send({
        dataset_id: dataset.id,
        prompt_id: prompt.id,
        version_ids: [v1.id],
        models: ['gpt-4o-mini'],
        ...(opts.experimentName ? { name: opts.experimentName } : {}),
      })
      .expect(201)
  ).body;

  const runRes = (await agent.post(`/api/v1/experiments/${experiment.id}/runs`).expect(202)).body;
  const runRow = await prisma.experimentRun.findUnique({ where: { id: runRes.run_id } });

  return {
    agent,
    teamId,
    userId,
    email,
    promptId: prompt.id,
    datasetId: dataset.id,
    experimentId: experiment.id,
    runId: runRes.run_id,
    grid: runRow!.grid as unknown as GridCell[],
    exampleIds: [example1.id, example2.id],
  };
}

/**
 * Produces and judges every cell of an arranged run, then finalizes it. v1
 * scores 90/88 and the baseline (the prompt's `production` alias, which
 * `arrangeRun` points at v2 — `resolveGrid` resolves to this by default when
 * no `alias` is requested) scores 40/38, so the run's overall mean is 64 and
 * its top variant is v1.
 */
async function produceAndJudge(run: ArrangedRun): Promise<void> {
  const v1Cell = run.grid.find((cell) => cell.variantLabel === 'v1')!;
  const baselineCell = run.grid.find((cell) => cell.variantLabel === 'production')!;

  mockFetch(CANNED_OPENAI);
  for (const cell of [v1Cell, baselineCell]) {
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
  queueFetchResponseOnce(cannedJudge({ score: 90, passed: true, reason: 'v1 e1' }));
  queueFetchResponseOnce(cannedJudge({ score: 88, passed: true, reason: 'v1 e2' }));
  queueFetchResponseOnce(cannedJudge({ score: 40, passed: false, reason: 'production e1' }));
  queueFetchResponseOnce(cannedJudge({ score: 38, passed: false, reason: 'production e2' }));
  for (const result of results) {
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
  // Same BullMQ/ioredis teardown as the sibling run suites -- startRun opens a
  // real connection via the memoized singletons in ../queue.
  await getFlowProducer().close();
  await getRedisConnection().quit();
});

describe('GET /runs', () => {
  it('lists a finished run with its dataset, grid shape, scores and starter', async () => {
    const run = await arrangeRun({ experimentName: 'greeting sweep' });
    await produceAndJudge(run);

    const res = await run.agent.get('/api/v1/runs').expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(20);
    expect(res.body.data).toHaveLength(1);

    const row = res.body.data[0];
    expect(row.id).toBe(run.runId);
    expect(row.status).toBe('succeeded');
    expect(row.kind).toBe('evaluation');
    expect(row.experimentId).toBe(run.experimentId);
    expect(row.experimentName).toBe('greeting sweep');
    expect(row.datasetId).toBe(run.datasetId);
    expect(row.datasetName).toBe('greetings');
    expect(row.promptId).toBe(run.promptId);
    expect(row.promptName).toBe('greeting');

    // v1 (explicit) + production baseline (v2, added by resolveGrid) x one model x 2 examples.
    expect(row.variantCount).toBe(2);
    expect(row.modelCount).toBe(1);
    expect(row.exampleCount).toBe(2);

    expect(row.results).toEqual({ total: 4, succeeded: 4, errored: 0, scored: 4 });
    // (90 + 88 + 40 + 38) / 4 — the example-weighted mean across both variants.
    expect(row.avgScore).toBe(64);
    expect(row.passRate).toBe(0.5);
    expect(row.topVariantLabel).toBe('v1');

    expect(row.startedBy.id).toBe(run.userId);
    expect(row.startedBy.email).toBe(run.email);
    expect(typeof row.createdAt).toBe('string');
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a queued run with zeroed counts and null scores, not zeros', async () => {
    const run = await arrangeRun();

    const row = (await run.agent.get('/api/v1/runs').expect(200)).body.data[0];

    expect(row.id).toBe(run.runId);
    expect(row.status).toBe('queued');
    expect(row.results).toEqual({ total: 0, succeeded: 0, errored: 0, scored: 0 });
    expect(row.avgScore).toBeNull();
    expect(row.passRate).toBeNull();
    expect(row.topVariantLabel).toBeNull();
    expect(row.startedAt).toBeNull();
    expect(row.endedAt).toBeNull();
    expect(row.durationMs).toBeNull();
    // The example snapshot is frozen at run-start, so the count is already real.
    expect(row.exampleCount).toBe(2);
  });

  it('never leaks another team’s runs', async () => {
    const mine = await arrangeRun();
    const theirs = await arrangeRun();

    const mineList = (await mine.agent.get('/api/v1/runs').expect(200)).body;
    expect(mineList.total).toBe(1);
    expect(mineList.data.map((r: { id: string }) => r.id)).toEqual([mine.runId]);

    const theirsList = (await theirs.agent.get('/api/v1/runs').expect(200)).body;
    expect(theirsList.data.map((r: { id: string }) => r.id)).toEqual([theirs.runId]);

    // The direct read is scoped the same way, so a leaked id would still 404.
    await mine.agent.get(`/api/v1/runs/${theirs.runId}`).expect(404);
  });

  it('orders newest first, pages, and filters by status and dataset', async () => {
    const first = await arrangeRun();
    // A second run of the same experiment, and a third against a fresh dataset,
    // so the dataset filter has something to exclude.
    const secondRunId = (await first.agent.post(`/api/v1/experiments/${first.experimentId}/runs`).expect(202)).body
      .run_id;

    const otherDataset = (await first.agent.post('/api/v1/datasets').send({ name: 'others' }).expect(201)).body;
    await first.agent
      .post(`/api/v1/datasets/${otherDataset.id}/examples`)
      .send({ input: { name: 'Cy' }, criteria: 'be brief' })
      .expect(201);
    const otherPrompt = (await first.agent.post('/api/v1/prompts').send({ name: 'farewell' }).expect(201)).body;
    const otherVersion = (
      await first.agent
        .post(`/api/v1/prompts/${otherPrompt.id}/versions`)
        .send({ messages: [{ role: 'user', content: 'Say bye to {{ name }}' }] })
        .expect(201)
    ).body;
    const otherExperiment = (
      await first.agent
        .post('/api/v1/experiments')
        .send({
          dataset_id: otherDataset.id,
          prompt_id: otherPrompt.id,
          models: ['gpt-4o-mini'],
          version_ids: [otherVersion.id],
        })
        .expect(201)
    ).body;
    const thirdRunId = (await first.agent.post(`/api/v1/experiments/${otherExperiment.id}/runs`).expect(202)).body
      .run_id;

    const all = (await first.agent.get('/api/v1/runs').expect(200)).body;
    expect(all.total).toBe(3);
    expect(all.data.map((r: { id: string }) => r.id)).toEqual([thirdRunId, secondRunId, first.runId]);

    const pageOne = (await first.agent.get('/api/v1/runs?limit=2').expect(200)).body;
    expect(pageOne.total).toBe(3);
    expect(pageOne.data.map((r: { id: string }) => r.id)).toEqual([thirdRunId, secondRunId]);

    const pageTwo = (await first.agent.get('/api/v1/runs?limit=2&page=2').expect(200)).body;
    expect(pageTwo.total).toBe(3);
    expect(pageTwo.data.map((r: { id: string }) => r.id)).toEqual([first.runId]);

    const byDataset = (await first.agent.get(`/api/v1/runs?dataset_id=${otherDataset.id}`).expect(200)).body;
    expect(byDataset.data.map((r: { id: string }) => r.id)).toEqual([thirdRunId]);

    const byPrompt = (await first.agent.get(`/api/v1/runs?prompt_id=${first.promptId}`).expect(200)).body;
    expect(byPrompt.data.map((r: { id: string }) => r.id)).toEqual([secondRunId, first.runId]);

    // Every run is still queued, so `succeeded` matches nothing and `queued` all three.
    expect((await first.agent.get('/api/v1/runs?status=succeeded').expect(200)).body).toMatchObject({
      total: 0,
      data: [],
    });
    expect((await first.agent.get('/api/v1/runs?status=queued').expect(200)).body.total).toBe(3);
  });

  it('rejects an unknown status and an over-cap limit with 400', async () => {
    const { agent } = await authedAgent(app);

    await agent.get('/api/v1/runs?status=cancelled').expect(400);
    await agent.get('/api/v1/runs?limit=500').expect(400);
    await agent.get('/api/v1/runs?dataset_id=not-a-uuid').expect(400);
  });

  it('requires authentication', async () => {
    await request(app).get('/api/v1/runs').expect(401);
  });

  it('counts an errored cell out of succeeded and still lists the run', async () => {
    const run = await arrangeRun();
    const v1Cell = run.grid.find((cell) => cell.variantLabel === 'v1')!;

    // A provider failure on one cell: processCell records it as a terminal
    // error result rather than throwing away the run.
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: 'upstream boom' } }),
      text: async () => 'upstream boom',
    } as unknown as Response);
    await expect(
      processCell({
        teamId: run.teamId,
        runId: run.runId,
        cellKey: v1Cell.cellKey,
        variantKind: v1Cell.variantKind,
        promptVersionId: v1Cell.promptVersionId,
        variantLabel: v1Cell.variantLabel,
        model: v1Cell.model,
        exampleId: run.exampleIds[0],
      }),
    ).rejects.toThrow();

    // processCell never writes a terminal row itself — the worker's failed-job
    // handler does, through this same repository call.
    const errored = await new RunsRepository().writeResultError({
      teamId: run.teamId,
      experimentRunId: run.runId,
      datasetExampleId: run.exampleIds[0],
      variantKind: v1Cell.variantKind,
      promptVersionId: v1Cell.promptVersionId,
      variantLabel: v1Cell.variantLabel,
      model: v1Cell.model,
      errorMessage: 'Provider error (500): upstream boom',
    });
    expect(errored.score).toBeNull();

    const row = (await run.agent.get('/api/v1/runs').expect(200)).body.data[0];
    expect(row.results).toEqual({ total: 1, succeeded: 0, errored: 1, scored: 0 });
    expect(row.avgScore).toBeNull();
  });
});
