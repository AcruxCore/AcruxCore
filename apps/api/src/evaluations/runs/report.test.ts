import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { RunsRepository } from './runs.repository';
import { processCell, processFinalize, processJudge } from './index';
import { getFlowProducer, getRedisConnection } from '../queue';
import { authedAgent } from '../../test-utils';

const app = createApp();
const runsRepo = new RunsRepository();

const CANNED_OPENAI = {
  id: 'chatcmpl-int',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi Al!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
};

function mockFetchOnce(body: unknown, ok = true, status = 200): void {
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response);
}

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

async function createConnection(agent: ReturnType<typeof request.agent>): Promise<string> {
  const res = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
    .expect(201);
  return res.body.id;
}

async function registerModel(agent: ReturnType<typeof request.agent>, credentialId: string, name = 'gpt-4o-mini'): Promise<void> {
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: name, upstreamModel: name, credentialId })
    .expect(201);
}

interface ScoredRunGridCell {
  cellKey: string;
  variantKind: string;
  promptVersionId: string;
  variantLabel: string;
  model: string;
}

/**
 * Arranges a full run through the real HTTP + processor path: a prompt with
 * v1 ("Say hi to {{ name }}") and v2 ("Say hello to {{ name }}") promoted to
 * `production`, an experiment naming only `v1` explicitly (so `resolveGrid`
 * adds `v2` back in as the `production`-baseline cell), one model, and a
 * dataset with 2 examples (each carrying `criteria` so the judge actually
 * scores them). Starts the run over HTTP (`POST /experiments/:id/runs`),
 * which snapshots the examples and freezes the grid, but does not itself
 * produce/score any cells — callers drive `processCell`/`processJudge`
 * themselves against the returned `grid`/`exampleIds`.
 */
async function arrangeRun(): Promise<{
  agent: ReturnType<typeof request.agent>;
  teamId: string;
  runId: string;
  grid: ScoredRunGridCell[];
  exampleIds: string[];
}> {
  const { agent, teamId } = await authedAgent(app);
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
    runId: runRes.run_id,
    grid: runRow!.grid as unknown as ScoredRunGridCell[],
    exampleIds: [example1.id, example2.id],
  };
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

beforeEach(async () => {
  await truncateTables();
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
  // Same BullMQ/ioredis teardown as run-engine.test.ts -- startRun opens a
  // real connection via the memoized singletons in ../queue; without closing
  // them Jest never exits on its own. See that file's own comment for detail.
  await getFlowProducer().close();
  await getRedisConnection().quit();
});

describe('GET /runs/:id/report', () => {
  it('returns the matrix with baseline, deltas, and winner', async () => {
    const { agent, teamId, runId, grid, exampleIds } = await arrangeRun();
    const v1Cell = grid.find((cell) => cell.variantLabel === 'v1')!;
    const productionCell = grid.find((cell) => cell.variantLabel === 'production')!;

    mockFetchOnce(CANNED_OPENAI);
    // v1 first, then production, each x both examples -- the exact order
    // eval_results are produced in, so results[] below (ordered by
    // createdAt) lines up 1:1 with the queued judge verdicts below.
    for (const cell of [v1Cell, productionCell]) {
      for (const exampleId of exampleIds) {
        await processCell({
          teamId,
          runId,
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
      where: { experimentRunId: runId },
      orderBy: { createdAt: 'asc' },
    });
    expect(results.length).toBe(4);

    // v1 scores deterministically higher than production on both examples.
    jest.restoreAllMocks();
    queueFetchResponseOnce(cannedJudge({ score: 90, passed: true, reason: 'v1 e1: great' }));
    queueFetchResponseOnce(cannedJudge({ score: 88, passed: true, reason: 'v1 e2: great' }));
    queueFetchResponseOnce(cannedJudge({ score: 40, passed: false, reason: 'production e1: mediocre' }));
    queueFetchResponseOnce(cannedJudge({ score: 38, passed: false, reason: 'production e2: mediocre' }));
    for (const result of results) {
      await processJudge({ teamId, resultId: result.id });
    }

    await processFinalize({ teamId, runId });

    const report = (await agent.get(`/api/v1/runs/${runId}/report`).expect(200)).body;

    expect(report.cells.some((c: any) => c.isProductionBaseline)).toBe(true);
    expect(report.winner).not.toBeNull();
    expect(report.winner.variantLabel).toBe('v1');

    const v1 = report.cells.find((c: any) => c.variantLabel === 'v1');
    expect(v1.avgScore).toBe(89);
    expect(v1.deltaVsBaseline.label).toBe('improved');

    const baseline = report.cells.find((c: any) => c.isProductionBaseline);
    expect(baseline.avgScore).toBe(39);
    expect(baseline.deltaVsBaseline).toBeNull();
  });

  it('keeps the production baseline (and regression deltas) when the production version is listed explicitly in version_ids', async () => {
    // Regression guard: when the user lists the production version *itself* in
    // version_ids, resolveGrid does NOT add a separate `production`-labeled
    // cell (the guard sees it is already covered). The baseline must still be
    // recognized off the frozen grid flag — not reconstructed from a
    // `variantLabel === 'production'` string, which no cell carries here — or
    // the whole regression view silently disappears.
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
    const v1 = (
      await agent
        .post(`/api/v1/prompts/${prompt.id}/versions`)
        .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] })
        .expect(201)
    ).body;
    const v2 = (
      await agent
        .post(`/api/v1/prompts/${prompt.id}/versions`)
        .send({ messages: [{ role: 'user', content: 'Say hello to {{ name }}' }] })
        .expect(201)
    ).body;
    // production == v1, the version the experiment also names explicitly below.
    await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

    const dataset = (await agent.post('/api/v1/datasets').send({ name: 'greetings' }).expect(201)).body;
    const example1 = (
      await agent.post(`/api/v1/datasets/${dataset.id}/examples`).send({ input: { name: 'Al' }, criteria: 'reply in third person' }).expect(201)
    ).body;
    const example2 = (
      await agent.post(`/api/v1/datasets/${dataset.id}/examples`).send({ input: { name: 'Bo' }, criteria: 'reply politely' }).expect(201)
    ).body;

    // Both the production version (v1) and v2 are listed explicitly.
    const experiment = (
      await agent
        .post('/api/v1/experiments')
        .send({ dataset_id: dataset.id, prompt_id: prompt.id, version_ids: [v1.id, v2.id], models: ['gpt-4o-mini'] })
        .expect(201)
    ).body;

    const runRes = (await agent.post(`/api/v1/experiments/${experiment.id}/runs`).expect(202)).body;
    const runId = runRes.run_id;
    const runRow = await prisma.experimentRun.findUnique({ where: { id: runId } });
    const grid = runRow!.grid as unknown as ScoredRunGridCell[];
    const v1Cell = grid.find((c) => c.promptVersionId === v1.id)!;
    const v2Cell = grid.find((c) => c.promptVersionId === v2.id)!;
    const exampleIds = [example1.id, example2.id];

    // No cell is labeled 'production' — v1 (the production version) is an
    // explicit 'v1' cell. The old label heuristic would find no baseline.
    expect(grid.some((c) => c.variantLabel === 'production')).toBe(false);

    mockFetchOnce(CANNED_OPENAI);
    for (const cell of [v1Cell, v2Cell]) {
      for (const exampleId of exampleIds) {
        await processCell({
          teamId,
          runId,
          cellKey: cell.cellKey,
          variantKind: cell.variantKind,
          promptVersionId: cell.promptVersionId,
          variantLabel: cell.variantLabel,
          model: cell.model,
          exampleId,
        });
      }
    }

    const results = await prisma.evalResult.findMany({ where: { experimentRunId: runId }, orderBy: { createdAt: 'asc' } });
    expect(results.length).toBe(4);

    // v1 (== production baseline) scores low; v2 scores high.
    jest.restoreAllMocks();
    queueFetchResponseOnce(cannedJudge({ score: 40, passed: false, reason: 'v1 e1' }));
    queueFetchResponseOnce(cannedJudge({ score: 42, passed: false, reason: 'v1 e2' }));
    queueFetchResponseOnce(cannedJudge({ score: 90, passed: true, reason: 'v2 e1' }));
    queueFetchResponseOnce(cannedJudge({ score: 88, passed: true, reason: 'v2 e2' }));
    for (const result of results) {
      await processJudge({ teamId, resultId: result.id });
    }
    await processFinalize({ teamId, runId });

    const report = (await agent.get(`/api/v1/runs/${runId}/report`).expect(200)).body;

    // The explicitly-listed production version is recognized as the baseline.
    const baselineCells = report.cells.filter((c: any) => c.isProductionBaseline);
    expect(baselineCells.length).toBe(1);
    expect(baselineCells[0].variantLabel).toBe(v1Cell.variantLabel);
    expect(baselineCells[0].deltaVsBaseline).toBeNull();

    // Regression view survives: v2's delta vs the production baseline is real.
    const v2ReportCell = report.cells.find((c: any) => c.variantLabel === v2Cell.variantLabel);
    expect(v2ReportCell.deltaVsBaseline.label).toBe('improved');
  });

  it('returns a partial report (not an error) when some cells are unscored or unproduced', async () => {
    const { agent, teamId, runId, grid, exampleIds } = await arrangeRun();
    const v1Cell = grid.find((cell) => cell.variantLabel === 'v1')!;

    // Produce exactly one of the four (cell x example) combinations, and
    // deliberately never judge it or touch the production cell at all.
    mockFetchOnce(CANNED_OPENAI);
    await processCell({
      teamId,
      runId,
      cellKey: v1Cell.cellKey,
      variantKind: v1Cell.variantKind,
      promptVersionId: v1Cell.promptVersionId,
      variantLabel: v1Cell.variantLabel,
      model: v1Cell.model,
      exampleId: exampleIds[0]!,
    });

    const report = (await agent.get(`/api/v1/runs/${runId}/report`).expect(200)).body;

    const v1 = report.cells.find((c: any) => c.variantLabel === 'v1');
    expect(v1.avgScore).toBeNull();
    expect(v1.exampleCount).toBe(1);
    expect(v1.unscoredCount).toBe(1);
    expect(v1.deltaVsBaseline.label).toBe('unknown');

    const baseline = report.cells.find((c: any) => c.isProductionBaseline);
    expect(baseline.avgScore).toBeNull();
    expect(baseline.exampleCount).toBe(0);
  });

  it('returns 404 for a run belonging to another team', async () => {
    const { runId } = await arrangeRun();
    const { agent: agentB } = await authedAgent(app);

    await agentB.get(`/api/v1/runs/${runId}/report`).expect(404);
  });
});

describe('GET /runs/:id/cells/:cellKey', () => {
  it('drills into per-example outputs, judge reasoning, and traces', async () => {
    const { agent, teamId, runId, grid, exampleIds } = await arrangeRun();
    const v1Cell = grid.find((cell) => cell.variantLabel === 'v1')!;

    mockFetchOnce(CANNED_OPENAI);
    for (const exampleId of exampleIds) {
      await processCell({
        teamId,
        runId,
        cellKey: v1Cell.cellKey,
        variantKind: v1Cell.variantKind,
        promptVersionId: v1Cell.promptVersionId,
        variantLabel: v1Cell.variantLabel,
        model: v1Cell.model,
        exampleId,
      });
    }

    const results = await prisma.evalResult.findMany({
      where: { experimentRunId: runId, variantLabel: 'v1' },
      orderBy: { createdAt: 'asc' },
    });

    jest.restoreAllMocks();
    queueFetchResponseOnce(cannedJudge({ score: 90, passed: true, reason: 'third person, good' }));
    queueFetchResponseOnce(cannedJudge({ score: 88, passed: true, reason: 'polite enough' }));
    for (const result of results) {
      await processJudge({ teamId, resultId: result.id });
    }

    const cell = (await agent.get(`/api/v1/runs/${runId}/cells/${encodeURIComponent(v1Cell.cellKey)}`).expect(200)).body;

    expect(cell.cellKey).toBe(v1Cell.cellKey);
    expect(cell.variantLabel).toBe('v1');
    expect(cell.model).toBe('gpt-4o-mini');
    expect(cell.examples.length).toBe(2);
    expect(cell.examples[0]).toHaveProperty('output');
    expect(cell.examples[0]).toHaveProperty('reason');
    expect(cell.examples[0].traceId).toBeTruthy();
    expect(cell.examples[0].judgeTraceId).toBeTruthy();
    expect(cell.examples[0]).toHaveProperty('criteria');
    expect(cell.examples[0]).toHaveProperty('input');
    expect(cell.examples[0].score).not.toBeNull();
  });

  it('returns 404 for a run belonging to another team', async () => {
    const { runId, grid } = await arrangeRun();
    const v1Cell = grid.find((cell) => cell.variantLabel === 'v1')!;
    const { agent: agentB } = await authedAgent(app);

    await agentB.get(`/api/v1/runs/${runId}/cells/${encodeURIComponent(v1Cell.cellKey)}`).expect(404);
  });
});
