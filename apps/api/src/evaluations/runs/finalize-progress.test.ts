import { Queue, QueueEvents, Worker, type Job } from 'bullmq';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';
import {
  EVAL_CELLS_QUEUE,
  EVAL_RUNS_QUEUE,
  getCellsQueue,
  getRedisConnection,
  getRunsQueue,
  type CellJobData,
  type FinalizeJobData,
} from '../queue';
import { RunsRepository } from './runs.repository';
import { markFinalizeExhausted, processFinalizeJob } from './finalize.processor';

const app = createApp();
const runsRepo = new RunsRepository();
const EXAMPLES = 4;

// The finalize job's retry budget, shrunk so a test takes seconds: 3 polls 150 ms
// apart is a 450 ms budget. Verdicts below arrive 300 ms apart, so a run that keeps
// making progress outlives the budget — the shape of a slow judge model.
const JOB_OPTS = { attempts: 3, backoff: { type: 'fixed' as const, delay: 150 } };

/**
 * Signs up, registers a model, and creates a prompt, a dataset with EXAMPLES rows and
 * an experiment, then starts a run through `POST /experiments/:id/runs` — the real
 * path, which enqueues the finalize job as a BullMQ Flow parent over one cell job per
 * example.
 */
async function startRun(): Promise<{ teamId: string; runId: string }> {
  const owner = await authedAgent(app);
  const conn = await owner.agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
    .expect(201);
  await owner.agent
    .post('/api/v1/gateway/models')
    .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id })
    .expect(201);
  const prompt = (await owner.agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
  const version = (
    await owner.agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] })
      .expect(201)
  ).body;
  const dataset = (await owner.agent.post('/api/v1/datasets').send({ name: 'greetings' }).expect(201)).body;
  await owner.agent
    .post(`/api/v1/datasets/${dataset.id}/examples/bulk`)
    .send({
      examples: Array.from({ length: EXAMPLES }, (_, i) => ({ input: { name: `name${i}` }, criteria: 'Greets them by name.' })),
    })
    .expect(201);
  const experiment = (
    await owner.agent
      .post('/api/v1/experiments')
      .send({
        dataset_id: dataset.id,
        prompt_id: prompt.id,
        version_ids: [version.id],
        models: ['gpt-4o-mini'],
        judge_model: 'gpt-4o-mini',
      })
      .expect(201)
  ).body;
  const run = (await owner.agent.post(`/api/v1/experiments/${experiment.id}/runs`).send({}).expect(202)).body;
  return { teamId: owner.teamId, runId: run.run_id };
}

/**
 * Consumes the real cell queue and writes each cell's answer, as `cell.processor`
 * would after its model call. The model call is the one thing a test may replace: it
 * is a paid outbound request. No judge job is enqueued — each test writes the
 * verdicts itself, at the pace it is testing.
 */
function startCellStandIn(): Worker<CellJobData> {
  return new Worker<CellJobData>(
    EVAL_CELLS_QUEUE,
    async (job) => {
      await runsRepo.writeResult({
        teamId: job.data.teamId,
        experimentRunId: job.data.runId,
        datasetExampleId: job.data.exampleId,
        variantKind: job.data.variantKind,
        promptVersionId: job.data.promptVersionId,
        variantLabel: job.data.variantLabel,
        model: job.data.model,
        output: 'Hi!',
      });
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );
}

/**
 * Starts a finalize worker wired the way apps/worker wires it: `processFinalizeJob`
 * as the processor, and `markFinalizeExhausted` once a job's attempts run out.
 */
function startFinalizeWorker(queueName: string, minStallMs?: number): Worker<FinalizeJobData> {
  const worker = new Worker<FinalizeJobData>(queueName, (job, token) => processFinalizeJob(job, token, { minStallMs }), {
    connection: getRedisConnection(),
    concurrency: 1,
  });
  worker.on('failed', async (job: Job<FinalizeJobData> | undefined) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) await markFinalizeExhausted(job.data, job.failedReason);
  });
  return worker;
}

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const runStatus = (runId: string) => async () =>
  (await prisma.experimentRun.findUniqueOrThrow({ where: { id: runId } })).status;
const isTerminal = (s: string) => s === 'succeeded' || s === 'failed';
const resultIdsFor = (runId: string) => async () =>
  (await prisma.evalResult.findMany({ where: { experimentRunId: runId }, orderBy: { createdAt: 'asc' } })).map((r) => r.id);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('finalize waits for a run that is still making progress', () => {
  const workers: Worker[] = [];
  const extraQueues: Queue[] = [];

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE
      eval_results, experiment_runs, experiments, dataset_examples, datasets,
      gateway_model_fallbacks, gateway_models, provider_connections,
      prompt_aliases, prompt_versions, prompts,
      notification_preferences, email_log, audit_log, api_keys, team_members, teams, users
      RESTART IDENTITY CASCADE`);
    await Promise.all([getCellsQueue().obliterate({ force: true }), getRunsQueue().obliterate({ force: true })]);
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.close()));
    for (const q of extraQueues.splice(0)) {
      await q.obliterate({ force: true });
      await q.close();
    }
  });

  // The production shape: finalize is the Flow parent of the run's cell jobs, and each
  // not-ready poll moves that parent back to delayed. 4 verdicts 4 s apart outlast
  // several 3 s polls, so the parent is delayed and re-run more than once.
  it('succeeds as a Flow parent while verdicts keep arriving between polls', async () => {
    const { runId } = await startRun();
    workers.push(startCellStandIn(), startFinalizeWorker(EVAL_RUNS_QUEUE));

    const ids = await waitFor(resultIdsFor(runId), (r) => r.length === EXAMPLES, 10_000);
    expect(ids).toHaveLength(EXAMPLES);
    for (const id of ids) {
      await sleep(4000);
      await runsRepo.writeVerdict(id, { score: 90, passed: true, reason: 'greets by name', judgeTraceId: null });
    }

    expect(await waitFor(runStatus(runId), isTerminal, 15_000)).toBe('succeeded');
    const run = await prisma.experimentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.error).toBeNull();
    expect(await prisma.evalResult.count({ where: { experimentRunId: runId, score: { not: null } } })).toBe(EXAMPLES);
    // The parent was re-run after several delayed polls, and none of them used an attempt.
    // The run row is written before BullMQ records the job as completed, so wait for both.
    const [job] = await waitFor(() => getRunsQueue().getJobs(['completed']), (j) => j.length > 0, 5000);
    expect(job?.name).toBe('finalize');
    expect(job.attemptsStarted).toBeGreaterThan(2);
    expect(job.attemptsMade).toBe(1);
  }, 60_000);

  // Every poll reads the run's progress. It counts in SQL rather than loading each result
  // with its answer text: on a 400-cell run that was ~320 kB per poll, every 3 s.
  it('counts produced, judged and errored results without loading them', async () => {
    const { teamId, runId } = await startRun();
    workers.push(startCellStandIn());
    const ids = await waitFor(resultIdsFor(runId), (r) => r.length === EXAMPLES, 10_000);
    await runsRepo.writeVerdict(ids[0], { score: 90, passed: true, reason: 'ok', judgeTraceId: null });
    await prisma.evalResult.update({ where: { id: ids[1] }, data: { errorMessage: 'provider timed out' } });

    expect(await runsRepo.countResultProgress(teamId, runId)).toEqual({ produced: 4, judged: 2, errored: 1 });
    // Another team's id sees nothing.
    expect(await runsRepo.countResultProgress('00000000-0000-0000-0000-000000000000', runId)).toEqual({
      produced: 0,
      judged: 0,
      errored: 0,
    });
  }, 30_000);

  // The stall arithmetic, on a plain job with a 450 ms budget so it runs in seconds.
  // The run itself is still started through the API.
  it('succeeds when verdicts keep arriving, even after more time than the attempt budget', async () => {
    const { teamId, runId } = await startRun();
    workers.push(startCellStandIn());
    const ids = await waitFor(resultIdsFor(runId), (r) => r.length === EXAMPLES, 10_000);

    const queue = new Queue<FinalizeJobData>(`finalize-progress-${Date.now()}`, { connection: getRedisConnection() });
    extraQueues.push(queue);
    workers.push(startFinalizeWorker(queue.name, 0));
    await queue.add('finalize', { teamId, runId }, JOB_OPTS);

    // 4 verdicts, 300 ms apart: 1.2 s in all, well past the 450 ms budget.
    for (const id of ids) {
      await sleep(300);
      await runsRepo.writeVerdict(id, { score: 90, passed: true, reason: 'greets by name', judgeTraceId: null });
    }

    expect(await waitFor(runStatus(runId), isTerminal, 5000)).toBe('succeeded');
    const run = await prisma.experimentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.error).toBeNull();
  }, 30_000);

  it('still fails a run that stops making progress, and says why', async () => {
    const { teamId, runId } = await startRun();
    workers.push(startCellStandIn());
    const ids = await waitFor(resultIdsFor(runId), (r) => r.length === EXAMPLES, 10_000);
    await runsRepo.writeVerdict(ids[0], { score: 90, passed: true, reason: 'ok', judgeTraceId: null });

    const queue = new Queue<FinalizeJobData>(`finalize-progress-${Date.now()}`, { connection: getRedisConnection() });
    extraQueues.push(queue);
    workers.push(startFinalizeWorker(queue.name, 0));
    await queue.add('finalize', { teamId, runId }, JOB_OPTS);

    // No more verdicts ever arrive: three judge jobs are lost.
    expect(await waitFor(runStatus(runId), isTerminal, 5000)).toBe('failed');
    const run = await prisma.experimentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.error).toMatch(/no progress/i);
    expect(run.error).toMatch(/1 of 4 results judged/);
  }, 30_000);
});
