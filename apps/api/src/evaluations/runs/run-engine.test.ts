import request from 'supertest';
import type { Worker } from 'bullmq';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { RunsRepository } from './runs.repository';
import { processCell, processFinalize, processJudge, markFinalizeExhausted } from './index';
import { getFlowProducer, getRedisConnection, getCellsQueue, getRunsQueue, getJudgeQueue, getOptimizeQueue } from '../queue';
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

/**
 * Arranges everything a cell/finalize test needs: a registered model, a prompt
 * with a committed v1 ("Say hi to {{ name }}") promoted to production, a
 * dataset with one example (`{ name: 'Al' }`), and an `experiments` row tying
 * them together (needed only to satisfy `experiment_runs.experiment_id`'s FK —
 * the run row itself is built by hand in each test via `runsRepo.createRun`).
 */
async function arrangeBasics(
  agent: ReturnType<typeof request.agent>,
): Promise<{ promptVersionId: string; exampleId: string; experimentId: string }> {
  const credId = await createConnection(agent);
  await registerModel(agent, credId);

  const prompt = (await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
  const version = (
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] })
      .expect(201)
  ).body;
  await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

  const dataset = (await agent.post('/api/v1/datasets').send({ name: 'greetings' }).expect(201)).body;
  const example = (
    await agent
      .post(`/api/v1/datasets/${dataset.id}/examples`)
      .send({ input: { name: 'Al' } })
      .expect(201)
  ).body;

  const experiment = (
    await agent
      .post('/api/v1/experiments')
      .send({
        dataset_id: dataset.id,
        prompt_id: prompt.id,
        version_ids: [version.id],
        models: ['gpt-4o-mini'],
      })
      .expect(201)
  ).body;

  return { promptVersionId: version.id, exampleId: example.id, experimentId: experiment.id };
}

/** Builds the run row + the grid/snapshot shared by every test below. */
async function createRun(
  teamId: string,
  experimentId: string,
  promptVersionId: string,
  exampleId: string,
): Promise<{ id: string }> {
  return runsRepo.createRun(teamId, experimentId, {
    exampleSnapshot: [{ exampleId, input: { name: 'Al' }, criteria: null }],
    grid: [{ cellKey: 'v1|gpt-4o-mini', variantKind: 'version', promptVersionId, versionLabel: 'v1', model: 'gpt-4o-mini' }],
  });
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

  // This is the first test file to exercise `startRun`, which opens a real
  // ioredis connection via the memoized `getFlowProducer()`/`getRedisConnection()`
  // singletons in ../queue. Without an explicit teardown, ioredis keeps
  // reconnecting and holds the event loop open forever, so Jest never exits on
  // its own (it prints "Jest did not exit one second after the test run has
  // completed" and hangs). Close the BullMQ object(s) built on top of the
  // connection first, then quit the underlying IORedis client last.
  await getFlowProducer().close();
  await getRedisConnection().quit();

  // The gated `apps/worker e2e` tests boot workers on apps/worker's *compiled*
  // queue singleton — a DIFFERENT ioredis instance than the ts-jest one quit
  // above (Node's require cache keys the compiled `dist/.../queue` module
  // separately from ts-jest's in-memory transform of the same TS source).
  // BullMQ's `Worker.close()` never quits a caller-supplied ("shared")
  // connection, so it stays open and holds the event loop, making Jest hang.
  // Quit it once here — after ALL e2e tests have run — rather than in each
  // test's `finally`, because it is a memoized singleton shared across the e2e
  // tests: quitting it per-test would kill the connection the next e2e test's
  // workers need. Guarded on TEST_REDIS_URL, the only case where that compiled
  // module was ever loaded.
  if (process.env.TEST_REDIS_URL) {
    const distQueue = require('../../../dist/src/evaluations/queue') as {
      getRedisConnection: () => import('ioredis').default;
    };
    await distQueue.getRedisConnection().quit();
  }
});

describe('processCell', () => {
  it('renders the version with the example variables and writes output + trace', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { promptVersionId, exampleId, experimentId } = await arrangeBasics(agent);
    const run = await createRun(teamId, experimentId, promptVersionId, exampleId);

    mockFetchOnce(CANNED_OPENAI);
    await processCell({
      teamId,
      runId: run.id,
      cellKey: 'v1|gpt-4o-mini',
      variantKind: 'version',
      promptVersionId,
      variantLabel: 'v1',
      model: 'gpt-4o-mini',
      exampleId,
    });

    const result = await prisma.evalResult.findFirst({ where: { experimentRunId: run.id } });
    expect(result!.output).not.toBeNull();
    expect(result!.traceId).not.toBeNull();

    const trace = await prisma.trace.findUnique({ where: { id: result!.traceId! } });
    expect(trace).not.toBeNull(); // the eval call produced a real trace
    expect(trace!.teamId).toBe(teamId);
  });

  it('transitions the run from queued to running and stamps startedAt when the first cell starts', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { promptVersionId, exampleId, experimentId } = await arrangeBasics(agent);
    const run = await createRun(teamId, experimentId, promptVersionId, exampleId);
    const before = await prisma.experimentRun.findUnique({ where: { id: run.id } });
    expect(before!.status).toBe('queued');
    expect(before!.startedAt).toBeNull();

    mockFetchOnce(CANNED_OPENAI);
    await processCell({
      teamId,
      runId: run.id,
      cellKey: 'v1|gpt-4o-mini',
      variantKind: 'version',
      promptVersionId,
      variantLabel: 'v1',
      model: 'gpt-4o-mini',
      exampleId,
    });

    const updated = await prisma.experimentRun.findUnique({ where: { id: run.id } });
    expect(updated!.status).toBe('running');
    expect(updated!.startedAt).not.toBeNull();
  });

  it('the produced trace comes from a call rendered with the example variable value', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { promptVersionId, exampleId, experimentId } = await arrangeBasics(agent);
    const run = await createRun(teamId, experimentId, promptVersionId, exampleId);

    mockFetchOnce(CANNED_OPENAI);
    await processCell({
      teamId,
      runId: run.id,
      cellKey: 'v1|gpt-4o-mini',
      variantKind: 'version',
      promptVersionId,
      variantLabel: 'v1',
      model: 'gpt-4o-mini',
      exampleId,
    });

    const result = await prisma.evalResult.findFirst({ where: { experimentRunId: run.id } });
    const span = await prisma.span.findFirst({ where: { traceId: result!.traceId! } });
    expect(span).not.toBeNull();
    expect(span!.kind).toBe('llm');

    // Prove the render actually substituted the example's variable: inspect the
    // exact body handed to the mocked provider fetch call.
    const fetchMock = global.fetch as unknown as jest.Mock;
    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(JSON.stringify(sentBody.messages)).toContain('Al');
  });

  it('rethrows on a provider failure; writeResultError separately records the terminal row', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { promptVersionId, exampleId, experimentId } = await arrangeBasics(agent);
    const run = await createRun(teamId, experimentId, promptVersionId, exampleId);

    mockFetchOnce({ error: { message: 'boom' } }, false, 500);

    await expect(
      processCell({
        teamId,
        runId: run.id,
        cellKey: 'v1|gpt-4o-mini',
        variantKind: 'version',
        promptVersionId,
        variantLabel: 'v1',
        model: 'gpt-4o-mini',
        exampleId,
      }),
    ).rejects.toThrow();

    // processCell itself never writes a terminal row on failure — that is the
    // worker's failed-job handler's responsibility (Task 6). Confirm nothing
    // was written here, then exercise that recording path directly.
    const before = await prisma.evalResult.count({ where: { experimentRunId: run.id } });
    expect(before).toBe(0);

    await runsRepo.writeResultError({
      teamId,
      experimentRunId: run.id,
      datasetExampleId: exampleId,
      variantKind: 'version',
      promptVersionId,
      variantLabel: 'v1',
      model: 'gpt-4o-mini',
      errorMessage: 'Provider error (502): boom',
    });

    const result = await prisma.evalResult.findFirst({ where: { experimentRunId: run.id } });
    expect(result!.output).toBeNull();
    expect(result!.errorMessage).toBe('Provider error (502): boom');
  });

  it('throws and writes nothing when promptVersionId belongs to a different team than data.teamId', async () => {
    // Team A owns the run; team B owns the prompt version. A CellJobData like
    // this should never occur once Task 5's grid-building lands (it always
    // takes the version id from the same team's experiment), but this proves
    // the defense-in-depth check: cross-team ids must be rejected exactly
    // like "not found", never rendered/sent through the gateway.
    const { agent: agentA, teamId: teamIdA } = await authedAgent(app);
    const { exampleId, experimentId } = await arrangeBasics(agentA);
    const run = await createRun(teamIdA, experimentId, 'unused-placeholder', exampleId);

    const { agent: agentB } = await authedAgent(app);
    const { promptVersionId: promptVersionIdB } = await arrangeBasics(agentB);

    mockFetchOnce(CANNED_OPENAI);
    await expect(
      processCell({
        teamId: teamIdA,
        runId: run.id,
        cellKey: 'v1|gpt-4o-mini',
        variantKind: 'version',
        promptVersionId: promptVersionIdB,
        variantLabel: 'v1',
        model: 'gpt-4o-mini',
        exampleId,
      }),
    ).rejects.toThrow(/not found/i);

    expect(global.fetch).not.toHaveBeenCalled();
    const result = await prisma.evalResult.findFirst({ where: { experimentRunId: run.id } });
    expect(result).toBeNull();
  });
});

describe('processFinalize', () => {
  it('marks the run succeeded once every cell has a non-error result', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { promptVersionId, exampleId, experimentId } = await arrangeBasics(agent);
    const run = await createRun(teamId, experimentId, promptVersionId, exampleId);

    mockFetchOnce(CANNED_OPENAI);
    await processCell({
      teamId,
      runId: run.id,
      cellKey: 'v1|gpt-4o-mini',
      variantKind: 'version',
      promptVersionId,
      variantLabel: 'v1',
      model: 'gpt-4o-mini',
      exampleId,
    });

    // This example has neither `criteria` nor a dataset `overallFeedback`, so
    // the judge intentionally skips scoring it — but it still must run so the
    // result gets marked "judged" (a `reason` set), which processFinalize now
    // requires before it will finalize the run (Task 4 of the E4 plan).
    const cellResult = await prisma.evalResult.findFirst({ where: { experimentRunId: run.id } });
    await processJudge({ teamId, resultId: cellResult!.id });

    await processFinalize({ teamId, runId: run.id });

    const updated = await prisma.experimentRun.findUnique({ where: { id: run.id } });
    expect(updated!.status).toBe('succeeded');
    expect(updated!.endedAt).not.toBeNull();
  });

  it('marks the run failed when every produced result errored', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { promptVersionId, exampleId, experimentId } = await arrangeBasics(agent);
    const run = await createRun(teamId, experimentId, promptVersionId, exampleId);

    await runsRepo.writeResultError({
      teamId,
      experimentRunId: run.id,
      datasetExampleId: exampleId,
      variantKind: 'version',
      promptVersionId,
      variantLabel: 'v1',
      model: 'gpt-4o-mini',
      errorMessage: 'Provider error (502): boom',
    });

    await processFinalize({ teamId, runId: run.id });

    const updated = await prisma.experimentRun.findUnique({ where: { id: run.id } });
    expect(updated!.status).toBe('failed');
    expect(updated!.endedAt).not.toBeNull();
  });
});

describe('markFinalizeExhausted (runWorker failed-handler logic)', () => {
  it('transitions a run stuck at queued to a terminal failed status with a clear error, once finalize retries are genuinely exhausted', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { promptVersionId, exampleId, experimentId } = await arrangeBasics(agent);
    const run = await createRun(teamId, experimentId, promptVersionId, exampleId);

    // Never call processCell/processJudge/processFinalize here: this run is
    // deliberately left exactly as `startRun` would leave it while cell/judge
    // jobs are still in flight -- `status: 'queued'`, no `endedAt`. That is
    // the exact state a run is stuck in forever today (before this fix) once
    // BullMQ gives up on retrying the finalize Flow-parent job: nothing else
    // ever calls `setRunStatus` in that scenario. `apps/worker`'s
    // `runWorker.on('failed', ...)` handler (apps/worker/src/index.ts) calls
    // `markFinalizeExhausted` exactly once it has confirmed
    // `job.attemptsMade >= job.opts.attempts` -- that BullMQ bookkeeping
    // check is exercised for the identical pattern used by
    // cellWorker/judgeWorker's own `'failed'` handlers in the gated e2e test
    // below; this test instead proves the actual state-transition/error-
    // message logic `markFinalizeExhausted` performs, directly and without
    // needing to wait out a real multi-minute BullMQ retry cycle.
    const before = await prisma.experimentRun.findUnique({ where: { id: run.id } });
    expect(before!.status).toBe('queued');
    expect(before!.endedAt).toBeNull();

    await markFinalizeExhausted(
      { teamId, runId: run.id },
      'Run not ready to finalize: cell/judge jobs still in flight',
    );

    const updated = await prisma.experimentRun.findUnique({ where: { id: run.id } });
    expect(updated!.status).toBe('failed');
    expect(updated!.endedAt).not.toBeNull();
    expect(updated!.error).toContain('finalize timed out waiting for cell/judge jobs to complete');
    expect(updated!.error).toContain('cell/judge jobs still in flight');
  });
});

describe('processJudge (E4 wiring)', () => {
  it('a run scores every produced cell', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
    const version = (
      await agent
        .post(`/api/v1/prompts/${prompt.id}/versions`)
        .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] })
        .expect(201)
    ).body;
    await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

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
        .send({ dataset_id: dataset.id, prompt_id: prompt.id, version_ids: [version.id], models: ['gpt-4o-mini'] })
        .expect(201)
    ).body;

    const run = await runsRepo.createRun(teamId, experiment.id, {
      exampleSnapshot: [
        { exampleId: example1.id, input: { name: 'Al' }, criteria: 'reply in third person' },
        { exampleId: example2.id, input: { name: 'Bo' }, criteria: 'reply politely' },
      ],
      grid: [{ cellKey: 'v1|gpt-4o-mini', variantKind: 'version', promptVersionId: version.id, versionLabel: 'v1', model: 'gpt-4o-mini' }],
    });

    // Two cell calls, both served the same canned generation.
    mockFetchOnce(CANNED_OPENAI);
    await processCell({
      teamId,
      runId: run.id,
      cellKey: 'v1|gpt-4o-mini',
      variantKind: 'version',
      promptVersionId: version.id,
      variantLabel: 'v1',
      model: 'gpt-4o-mini',
      exampleId: example1.id,
    });
    await processCell({
      teamId,
      runId: run.id,
      cellKey: 'v1|gpt-4o-mini',
      variantKind: 'version',
      promptVersionId: version.id,
      variantLabel: 'v1',
      model: 'gpt-4o-mini',
      exampleId: example2.id,
    });

    const results = await prisma.evalResult.findMany({
      where: { experimentRunId: run.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(results.length).toBe(2);

    // Canned judge verdicts, one per result: distinct one-shot mocks so each
    // processJudge call consumes exactly its own verdict.
    jest.restoreAllMocks();
    queueFetchResponseOnce(cannedJudge({ score: 80, passed: true, reason: 'third person, good' }));
    queueFetchResponseOnce(cannedJudge({ score: 60, passed: true, reason: 'polite enough' }));

    await processJudge({ teamId, resultId: results[0]!.id });
    await processJudge({ teamId, resultId: results[1]!.id });

    await processFinalize({ teamId, runId: run.id });

    const scored = await prisma.evalResult.findMany({ where: { experimentRunId: run.id } });
    expect(scored.every((r) => r.score !== null)).toBe(true);

    const updatedRun = await prisma.experimentRun.findUnique({ where: { id: run.id } });
    expect(updatedRun!.status).toBe('succeeded');
  });
});

describe('RunsRepository.markRunning', () => {
  it('flips a queued run to running once, stamping startedAt; a second call is a no-op that leaves startedAt untouched', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { promptVersionId, exampleId, experimentId } = await arrangeBasics(agent);
    const run = await createRun(teamId, experimentId, promptVersionId, exampleId);
    const initial = await prisma.experimentRun.findUnique({ where: { id: run.id } });
    expect(initial!.status).toBe('queued');
    expect(initial!.startedAt).toBeNull();

    await runsRepo.markRunning(run.id);
    const first = await prisma.experimentRun.findUnique({ where: { id: run.id } });
    expect(first!.status).toBe('running');
    expect(first!.startedAt).not.toBeNull();

    // A later cell starting must NOT re-stamp startedAt: markRunning only acts
    // on a still-queued run, so the first cell's start time is preserved.
    await runsRepo.markRunning(run.id);
    const second = await prisma.experimentRun.findUnique({ where: { id: run.id } });
    expect(second!.status).toBe('running');
    expect(second!.startedAt!.getTime()).toBe(first!.startedAt!.getTime());
  });
});

describe('POST /experiments/:id/runs', () => {
  it('snapshots examples, resolves the grid incl production baseline, and creates a queued run', async () => {
    const { agent } = await authedAgent(app);
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
    await agent
      .post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`)
      .send({ version_number: 2 })
      .expect(200);

    const dataset = (await agent.post('/api/v1/datasets').send({ name: 'greetings' }).expect(201)).body;
    await agent.post(`/api/v1/datasets/${dataset.id}/examples`).send({ input: { name: 'Al' } }).expect(201);
    await agent.post(`/api/v1/datasets/${dataset.id}/examples`).send({ input: { name: 'Bo' } }).expect(201);

    const exp = (
      await agent
        .post('/api/v1/experiments')
        .send({ dataset_id: dataset.id, prompt_id: prompt.id, version_ids: [v1.id], models: ['gpt-4o-mini'] })
        .expect(201)
    ).body;

    const run = (await agent.post(`/api/v1/experiments/${exp.id}/runs`).expect(202)).body;
    expect(run.status).toBe('queued');

    const row = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });
    const grid = row!.grid as Array<{ promptVersionId: string }>;
    // v1 (explicit) + v2 (production baseline) both present
    expect(new Set(grid.map((c) => c.promptVersionId))).toEqual(new Set([v1.id, v2.id]));
    expect((row!.exampleSnapshot as unknown[]).length).toBe(2);
  });

  it('returns 404 for cross-team start-run and get-run', async () => {
    const { agent: agentA } = await authedAgent(app);
    const { experimentId } = await arrangeBasics(agentA);

    const { agent: agentB } = await authedAgent(app);
    await agentB.post(`/api/v1/experiments/${experimentId}/runs`).expect(404);

    const runA = (await agentA.post(`/api/v1/experiments/${experimentId}/runs`).expect(202)).body;
    await agentB.get(`/api/v1/runs/${runA.run_id}`).expect(404);

    // Sanity: same team can read its own run
    const ownRes = await agentA.get(`/api/v1/runs/${runA.run_id}`).expect(200);
    expect(ownRes.body.status).toBe('queued');
  });
});

/** Polls `check` every 100ms until it returns `true`, or throws once `timeoutMs` elapses. */
async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

// Gated on TEST_REDIS_URL (unset in normal CI/dev runs, so this suite skips
// cleanly there): the only test in this file that exercises the *actual*
// apps/worker BullMQ Workers end to end, as opposed to calling
// processCell/processFinalize directly. Requires a real, reachable Redis (the
// env var is just a gate — REDIS_URL, defaulted to localhost:6379, is what the
// worker/queue code actually connects with).
//
// Running this one test also requires apps/worker's and apps/api's compiled
// `dist/` output to exist (see the two `require()` calls inside the test body
// below, which load compiled JS rather than TS source — see their own doc
// comments for why). Build both first:
//   cd apps/api && npm run build && cd ../worker && npm run build
// then run: TEST_REDIS_URL=redis://localhost:6379 npm test -- run-engine.test.ts
// (from apps/api). This is not wired into `turbo test`/`npm test` because the
// default (TEST_REDIS_URL unset) run of this file must never touch `dist/` —
// see the requires' own comments for why they are lazy.
describe('apps/worker e2e', () => {
  const maybeIt = process.env.TEST_REDIS_URL ? it : it.skip;

  maybeIt(
    'a full run completes: boot real workers -> start run over HTTP -> results present',
    async () => {
      // These two `require()`s are lazy — evaluated only here, inside this
      // test's own callback — rather than at module load time. `it.skip`
      // never invokes its callback, so when TEST_REDIS_URL is unset this
      // code never runs and this file has no dependency on `dist/` existing
      // at all. `dist/` is gitignored and nothing in the build pipeline
      // (turbo.json's `test` task only depends on `^build`, i.e. apps/api's
      // own upstream workspace deps, not the downstream apps/worker) builds
      // it before a normal `npm test` run. Do NOT hoist these back to the
      // top of the file "for readability" — that would make every one of
      // this file's other tests throw "Cannot find module" on a fresh
      // checkout or CI run that has never built dist/.

      /**
       * Loaded via a plain `require()` of apps/worker's *compiled* output
       * (`dist/index.js`, built by `cd apps/worker && npm run build` —
       * required before running this gated e2e test), not a static `import`
       * of its TypeScript source. Two reasons, both about avoiding a
       * cross-package tsconfig mismatch rather than about the worker code
       * itself:
       *
       * 1. apps/worker's tsconfig uses `moduleResolution: "NodeNext"` (needed
       *    so it can read apps/api's package.json `exports` map, which
       *    deliberately exposes only a narrow set of subpaths — no other
       *    apps/api internals). apps/api's own tsconfig uses the older
       *    classic (`"node10"`) resolution, the default for
       *    `module: "CommonJS"`, which does not understand `exports` maps at
       *    all.
       * 2. `ts-jest` transforms *any* `.ts` file it is asked to load —
       *    including one reached via a relative `require()` outside
       *    apps/api's own rootDir — using apps/api's tsconfig. So even a
       *    dynamic `require('.../worker/src/index')` would still route
       *    apps/worker's source through apps/api's classic resolver and fail
       *    the same way a static `import` would.
       *
       * Requiring the compiled `.js` instead sidesteps both: it is plain
       * CommonJS, so Jest loads it via Node's native `require()` (no ts-jest
       * transform, no apps/api tsconfig involved), and Node's own runtime
       * module resolution natively understands `exports` maps regardless of
       * what any tsconfig says. This still boots the *real* apps/worker code
       * — nothing is duplicated — without either package's tsconfig
       * changing, and without apps/api declaring a reverse dependency on
       * apps/worker (which would create a workspace cycle, since apps/worker
       * already depends on apps/api).
       */
      const workerModule = require('../../../../worker/dist/index') as {
        startWorkers: () => Promise<{
          cellWorker: Worker;
          runWorker: Worker;
          judgeWorker: Worker;
          optimizeWorker: Worker;
        }>;
      };
      const { startWorkers } = workerModule;

      // Earlier tests in this same file (the "POST /experiments/:id/runs"
      // block above) enqueue real BullMQ jobs against the same real Redis —
      // this is the first test in the file to actually boot a worker, so
      // without this, it would drain that whole backlog too, including jobs
      // whose teams/runs have since been truncated by those tests' own
      // cleanup. Obliterating both queues first guarantees this test's
      // worker only ever sees jobs enqueued by its own run below.
      await getCellsQueue().obliterate({ force: true });
      await getRunsQueue().obliterate({ force: true });
      await getJudgeQueue().obliterate({ force: true });
      // Also drain the optimize queue: startWorkers() boots the optimizeWorker
      // too, so any stale optimize job left in Redis by an earlier run would be
      // picked up here and processed against truncated data, hanging the suite.
      await getOptimizeQueue().obliterate({ force: true });

      const { cellWorker, runWorker, judgeWorker, optimizeWorker } = await startWorkers();
      try {
        const { agent } = await authedAgent(app);
        const { experimentId } = await arrangeBasics(agent);

        // arrangeBasics's dataset example has neither `criteria` nor an
        // `overallFeedback`, so the judge intentionally skips scoring it —
        // but it still must run so the result gets marked "judged" (Task 4),
        // which processFinalize now requires before the run can succeed.
        mockFetchOnce(CANNED_OPENAI);

        const run = (await agent.post(`/api/v1/experiments/${experimentId}/runs`).expect(202)).body;

        await waitFor(async () => {
          const row = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });
          return row?.status === 'succeeded';
        }, 10000);

        const results = await prisma.evalResult.findMany({ where: { experimentRunId: run.run_id } });
        expect(results.length).toBeGreaterThan(0);
        expect(results.every((r) => r.errorMessage === null)).toBe(true);
      } finally {
        // Close all four workers, but do NOT quit the shared dist ioredis
        // connection here — that is a memoized singleton reused by the next
        // e2e test, so quitting it per-test would leave that test's workers
        // unable to consume jobs. It is quit exactly once in `afterAll`.
        await cellWorker.close();
        await runWorker.close();
        await judgeWorker.close();
        await optimizeWorker.close();
      }
    },
    20000,
  );

  maybeIt(
    'a run whose every cell fails still reaches a terminal status (a failed cell must not hang the finalize parent forever)',
    async () => {
      // Same lazy-require rationale as the happy-path e2e above — see its
      // comments. This test exercises the real BullMQ Flow: a failed cell
      // *child* must not leave the finalize *parent* stuck in
      // `waiting-children` indefinitely (E3 fix — children carry
      // `ignoreDependencyOnFailure`). Before the fix, this run stays at
      // `status: 'queued'` forever and this test times out.
      const workerModule = require('../../../../worker/dist/index') as {
        startWorkers: () => Promise<{
          cellWorker: Worker;
          runWorker: Worker;
          judgeWorker: Worker;
          optimizeWorker: Worker;
        }>;
      };
      const { startWorkers } = workerModule;

      await getCellsQueue().obliterate({ force: true });
      await getRunsQueue().obliterate({ force: true });
      await getJudgeQueue().obliterate({ force: true });
      // Also drain the optimize queue: startWorkers() boots the optimizeWorker
      // too, so any stale optimize job left in Redis by an earlier run would be
      // picked up here and processed against truncated data, hanging the suite.
      await getOptimizeQueue().obliterate({ force: true });

      const { cellWorker, runWorker, judgeWorker, optimizeWorker } = await startWorkers();
      try {
        const { agent } = await authedAgent(app);
        const { experimentId } = await arrangeBasics(agent);

        // Every gateway call fails (persistent 500), so every cell job fails
        // terminally after exhausting its retries. The run must still finalize
        // to a terminal `failed` status rather than hanging at `queued`.
        mockFetchOnce({ error: { message: 'provider down' } }, false, 500);

        const run = (await agent.post(`/api/v1/experiments/${experimentId}/runs`).expect(202)).body;

        await waitFor(async () => {
          const row = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });
          return row?.status === 'failed' || row?.status === 'succeeded';
        }, 25000);

        const row = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });
        expect(row!.status).toBe('failed'); // every cell errored
        expect(row!.endedAt).not.toBeNull();

        const results = await prisma.evalResult.findMany({ where: { experimentRunId: run.run_id } });
        expect(results.length).toBeGreaterThan(0);
        expect(results.every((r) => r.errorMessage !== null)).toBe(true);
      } finally {
        // See the happy-path e2e's `finally` — close workers only; the shared
        // dist ioredis connection is quit once in `afterAll`.
        await cellWorker.close();
        await runWorker.close();
        await judgeWorker.close();
        await optimizeWorker.close();
      }
    },
    40000,
  );
});
