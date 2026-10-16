import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { processCell, processJudge } from './index';
import { getFlowProducer, getRedisConnection } from '../queue';
import { authedAgent } from '../../test-utils';

const app = createApp();

const CANNED_OPENAI = {
  id: 'chatcmpl-int',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
};

/** Persistent fetch mock for the cell (model) calls. */
function mockModelCalls(): void {
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => CANNED_OPENAI,
    text: async () => JSON.stringify(CANNED_OPENAI),
  } as unknown as Response);
}

/** Queues one judge verdict as the next provider response. */
function queueVerdict(score: number, passed: boolean): void {
  const body = {
    id: 'chatcmpl-judge',
    object: 'chat.completion',
    created: 1751536800,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ score, passed, reason: `score ${score}` }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  };
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

/** A team with a model, a prompt (v1, production = v2) and a four-example dataset. */
async function arrangeTeam(): Promise<{ agent: Agent; teamId: string; promptId: string; v1Id: string; datasetId: string; exampleIds: string[] }> {
  const { agent, teamId } = await authedAgent(app);
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id })
    .expect(201);

  const prompt = (await agent.post('/api/v1/prompts').send({ name: 'reply' }).expect(201)).body;
  const v1 = (
    await agent.post(`/api/v1/prompts/${prompt.id}/versions`).send({ messages: [{ role: 'user', content: 'Reply to {{ m }}' }] }).expect(201)
  ).body;
  await agent.post(`/api/v1/prompts/${prompt.id}/versions`).send({ messages: [{ role: 'user', content: 'Answer {{ m }}' }] }).expect(201);
  await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 2 }).expect(200);

  const dataset = (await agent.post('/api/v1/datasets').send({ name: 'messages' }).expect(201)).body;
  const exampleIds: string[] = [];
  for (const m of ['refund', 'invoice', 'login', 'pricing']) {
    const ex = (await agent.post(`/api/v1/datasets/${dataset.id}/examples`).send({ input: { m }, criteria: 'be correct' }).expect(201)).body;
    exampleIds.push(ex.id);
  }
  return { agent, teamId, promptId: prompt.id, v1Id: v1.id, datasetId: dataset.id, exampleIds };
}

/** Starts a run of v1 + the production baseline over the dataset and returns its frozen grid. */
async function startRun(agent: Agent, datasetId: string, promptId: string, v1Id: string): Promise<{ runId: string; grid: GridCell[] }> {
  const experiment = (
    await agent
      .post('/api/v1/experiments')
      .send({ dataset_id: datasetId, prompt_id: promptId, version_ids: [v1Id], models: ['gpt-4o-mini'], judge_model: 'gpt-4o-mini' })
      .expect(201)
  ).body;
  const run = (await agent.post(`/api/v1/experiments/${experiment.id}/runs`).expect(202)).body;
  const row = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });
  return { runId: run.run_id, grid: row!.grid as unknown as GridCell[] };
}

/** Produces and judges every (cell × example) result, with the given pass flags per cell. */
async function score(
  teamId: string,
  runId: string,
  cells: { cell: GridCell; verdicts: [number, boolean][] }[],
  exampleIds: string[],
): Promise<void> {
  mockModelCalls();
  for (const { cell } of cells) {
    for (const exampleId of exampleIds) {
      await processCell({ teamId, runId, cellKey: cell.cellKey, variantKind: cell.variantKind, promptVersionId: cell.promptVersionId, variantLabel: cell.variantLabel, model: cell.model, exampleId });
    }
  }
  jest.restoreAllMocks();
  for (const { cell, verdicts } of cells) {
    for (let i = 0; i < exampleIds.length; i++) {
      const result = await prisma.evalResult.findFirstOrThrow({
        where: { experimentRunId: runId, variantLabel: cell.variantLabel, model: cell.model, datasetExampleId: exampleIds[i] },
      });
      queueVerdict(...verdicts[i]);
      await processJudge({ teamId, resultId: result.id, judgeModel: 'gpt-4o-mini' });
    }
  }
}

async function truncateTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    eval_results, experiment_runs, experiments,
    dataset_examples, datasets,
    span_payloads, spans, trace_feedback, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys,
    gateway_model_fallbacks, gateway_models, provider_connections,
    prompt_aliases, prompt_versions, prompts,
    audit_log, api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
}

beforeEach(truncateTables);
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
  await getFlowProducer().close();
  await getRedisConnection().quit();
});

describe('GET /runs/:id/compare', () => {
  it('shows per-example changes that equal averages hide, within one run', async () => {
    const t = await arrangeTeam();
    const { runId, grid } = await startRun(t.agent, t.datasetId, t.promptId, t.v1Id);
    const v1 = grid.find((c) => c.variantLabel === 'v1')!;
    const prod = grid.find((c) => c.variantLabel === 'production')!;

    // Both cells pass 2 of 4 — the same pass rate — but v1 fixes "refund" and breaks "invoice".
    await score(t.teamId, runId, [
      { cell: prod, verdicts: [[30, false], [80, true], [90, true], [20, false]] },
      { cell: v1, verdicts: [[85, true], [40, false], [90, true], [25, false]] },
    ], t.exampleIds);

    const report = (await t.agent.get(`/api/v1/runs/${runId}/report`).expect(200)).body;
    const passRates = report.cells.map((c: { passRate: number }) => c.passRate);
    expect(passRates).toEqual([0.5, 0.5]);

    const res = await t.agent
      .get(`/api/v1/runs/${runId}/compare`)
      .query({ base_cell: prod.cellKey, target_cell: v1.cellKey })
      .expect(200);

    expect(res.body.base).toMatchObject({ runId, cellKey: prod.cellKey, variantLabel: 'production' });
    expect(res.body.target).toMatchObject({ runId, cellKey: v1.cellKey, variantLabel: 'v1' });
    expect(res.body.counts).toEqual({ improved: 1, regressed: 1, unchanged: 2, unscored: 0, missing: 0 });

    const byInput = Object.fromEntries(
      res.body.examples.map((e: { input: { m: string } }) => [e.input.m, e]),
    );
    expect(byInput.refund).toMatchObject({ change: 'improved', scoreDelta: 55, base: { passed: false, score: 30 }, target: { passed: true, score: 85 } });
    expect(byInput.invoice).toMatchObject({ change: 'regressed', scoreDelta: -40 });
    expect(byInput.login).toMatchObject({ change: 'unchanged', scoreDelta: 0 });
    expect(byInput.pricing).toMatchObject({ change: 'unchanged', scoreDelta: 5 });
    expect(byInput.refund.target.output).toBeDefined();
  });

  it('compares a cell across two runs of the same dataset', async () => {
    const t = await arrangeTeam();
    const first = await startRun(t.agent, t.datasetId, t.promptId, t.v1Id);
    const second = await startRun(t.agent, t.datasetId, t.promptId, t.v1Id);
    const cell1 = first.grid.find((c) => c.variantLabel === 'v1')!;
    const cell2 = second.grid.find((c) => c.variantLabel === 'v1')!;
    await score(t.teamId, first.runId, [{ cell: cell1, verdicts: [[90, true], [90, true], [90, true], [90, true]] }], t.exampleIds);
    await score(t.teamId, second.runId, [{ cell: cell2, verdicts: [[90, true], [10, false], [90, true], [90, true]] }], t.exampleIds);

    const res = await t.agent
      .get(`/api/v1/runs/${first.runId}/compare`)
      .query({ base_cell: cell1.cellKey, target_run_id: second.runId, target_cell: cell2.cellKey })
      .expect(200);
    expect(res.body.target.runId).toBe(second.runId);
    // The run detail names its dataset, so a client can list the runs it may compare against.
    const detail = (await t.agent.get(`/api/v1/runs/${second.runId}`).expect(200)).body;
    expect(detail.datasetId).toBe(t.datasetId);
    expect(res.body.counts).toMatchObject({ improved: 0, regressed: 1, unchanged: 3 });
  });

  it('refuses runs over different datasets, unknown cells, and another team’s run', async () => {
    const t = await arrangeTeam();
    const { runId, grid } = await startRun(t.agent, t.datasetId, t.promptId, t.v1Id);
    const v1 = grid.find((c) => c.variantLabel === 'v1')!;

    const otherDataset = (await t.agent.post('/api/v1/datasets').send({ name: 'other' }).expect(201)).body;
    await t.agent.post(`/api/v1/datasets/${otherDataset.id}/examples`).send({ input: { m: 'x' }, criteria: 'c' }).expect(201);
    const other = await startRun(t.agent, otherDataset.id, t.promptId, t.v1Id);
    const mismatch = await t.agent
      .get(`/api/v1/runs/${runId}/compare`)
      .query({ base_cell: v1.cellKey, target_run_id: other.runId, target_cell: other.grid[0].cellKey })
      .expect(400);
    expect(mismatch.body.error.code).toBe('DATASET_MISMATCH');

    const unknown = await t.agent
      .get(`/api/v1/runs/${runId}/compare`)
      .query({ base_cell: v1.cellKey, target_cell: 'v9|nope' })
      .expect(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');

    const noTarget = await t.agent.get(`/api/v1/runs/${runId}/compare`).query({ base_cell: v1.cellKey }).expect(400);
    expect(noTarget.body.error.message).toBe('`target_cell` is required.');

    const stranger = await authedAgent(app);
    await stranger.agent
      .get(`/api/v1/runs/${runId}/compare`)
      .query({ base_cell: v1.cellKey, target_cell: v1.cellKey })
      .expect(404);

    // Another team, comparing its OWN run against ours through `target_run_id`.
    const other2 = await arrangeTeam();
    const own = await startRun(other2.agent, other2.datasetId, other2.promptId, other2.v1Id);
    const foreignTarget = await other2.agent
      .get(`/api/v1/runs/${own.runId}/compare`)
      .query({ base_cell: own.grid[0].cellKey, target_run_id: runId, target_cell: v1.cellKey })
      .expect(404);
    expect(foreignTarget.body.error.message).toBe('Target run not found.');
  });
});
