import request from 'supertest';
import { Worker } from 'bullmq';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { processCell, processFinalize, processJudge } from './index';
import { reapStaleRuns } from './stale-runs.processor';
import { RunsRepository } from './runs.repository';
import {
  EVAL_JUDGE_QUEUE,
  getFlowProducer,
  getJudgeQueue,
  getRedisConnection,
  getRunsQueue,
  judgeJobId,
  type JudgeJobData,
} from '../queue';
import { authedAgent } from '../../test-utils';

const app = createApp();
const runsRepo = new RunsRepository();

type Agent = ReturnType<typeof request.agent>;

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

/** An OpenAI-shaped chat.completion whose assistant content is the given verdict. */
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

/** Every outbound provider call records its request body, then answers with `body`. */
function captureFetch(body: unknown): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
    sent.push(JSON.parse(String((init as RequestInit).body)));
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  return sent;
}

interface ArrangedRun {
  agent: Agent;
  teamId: string;
  datasetId: string;
  runId: string;
  resultIds: string[];
}

/**
 * Arranges a team with one prompt version, a 2-example dataset carrying an
 * overall feedback, an experiment, and one started run whose cells have all
 * been produced — but not judged.
 */
async function arrangeProducedRun(): Promise<ArrangedRun> {
  const { agent, teamId } = await authedAgent(app);
  const conn = (
    await agent
      .post('/api/v1/gateway/connections')
      .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
      .expect(201)
  ).body;
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.id })
    .expect(201);

  const prompt = (await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
  const v1 = (
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] })
      .expect(201)
  ).body;

  const dataset = (
    await agent.post('/api/v1/datasets').send({ name: 'greetings', overall_feedback: 'Be brief.' }).expect(201)
  ).body;
  for (const [name, criteria] of [['Al', 'reply in third person'], ['Bo', 'reply politely']]) {
    await agent.post(`/api/v1/datasets/${dataset.id}/examples`).send({ input: { name }, criteria }).expect(201);
  }

  const experiment = (
    await agent
      .post('/api/v1/experiments')
      .send({ dataset_id: dataset.id, prompt_id: prompt.id, version_ids: [v1.id], models: ['gpt-4o-mini'], judge_model: 'gpt-4o-mini' })
      .expect(201)
  ).body;
  const runId = (await agent.post(`/api/v1/experiments/${experiment.id}/runs`).expect(202)).body.run_id;
  const run = await prisma.experimentRun.findUniqueOrThrow({ where: { id: runId } });
  const snapshot = run.exampleSnapshot as unknown as Array<{ exampleId: string }>;

  mockFetch(CANNED_OPENAI);
  for (const cell of run.grid as unknown as GridCell[]) {
    for (const { exampleId } of snapshot) {
      await processCell({ teamId, runId, ...cell, exampleId });
    }
  }
  jest.restoreAllMocks();

  // processCell enqueued one judge job per result. Clear them: each test decides
  // what the judge queue holds.
  await getJudgeQueue().obliterate({ force: true });

  const results = await prisma.evalResult.findMany({ where: { experimentRunId: runId }, orderBy: { createdAt: 'asc' } });
  return { agent, teamId, datasetId: dataset.id, runId, resultIds: results.map((r) => r.id) };
}

/**
 * Settles every result the way a judge provider outage does: the worker's
 * `'failed'` handler writes this exact marker once the job's attempts run out.
 */
async function failEveryJudgeCall(run: ArrangedRun): Promise<void> {
  for (const id of run.resultIds) {
    await runsRepo.writeVerdict(id, {
      score: null,
      passed: null,
      reason: 'judge call failed: Provider rate limit (429): Usage limit reached for 5 hour.',
      judgeTraceId: null,
    });
  }
  await processFinalize({ teamId: run.teamId, runId: run.runId });
}

/**
 * Takes every queued judge job the way the judge worker does — fetch, run
 * `processJudge`, mark completed — answering each judge call with `score`.
 * Fails the test unless exactly the jobs for `resultIds` were queued.
 */
async function drainJudgeQueue(resultIds: string[], score: number): Promise<Array<Record<string, unknown>>> {
  const sent = captureFetch(cannedJudge({ score, passed: true, reason: 'fine now' }));
  const connection = getRedisConnection().duplicate();
  const worker = new Worker(EVAL_JUDGE_QUEUE, undefined, { connection, autorun: false });
  const ran: string[] = [];
  try {
    for (;;) {
      const job = await worker.getNextJob('drain-token', { block: false });
      if (!job) break;
      await processJudge(job.data as JudgeJobData);
      await job.moveToCompleted('done', 'drain-token', false);
      ran.push((job.data as JudgeJobData).resultId);
    }
  } finally {
    await worker.close();
    await connection.quit();
  }
  jest.restoreAllMocks();
  expect(ran.sort()).toEqual([...resultIds].sort());
  return sent;
}

/** Plain (non-flow) finalize jobs queued for one run — what a re-judge adds. */
async function queuedRejudgeFinalizers(runId: string): Promise<number> {
  const jobs = await getRunsQueue().getJobs(['waiting', 'delayed']);
  return jobs.filter((j) => j.data.runId === runId && !j.parentKey).length;
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
  await getJudgeQueue().obliterate({ force: true });
  await getRunsQueue().obliterate({ force: true });
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  // No queue cleanup here: the shared jest teardown may already have closed Redis,
  // and beforeEach empties both queues before every test anyway.
  await truncateTables();
  await prisma.$disconnect();
  await getFlowProducer().close();
  await getJudgeQueue().close();
  await getRunsQueue().close();
  await getRedisConnection().quit();
});

describe('POST /api/v1/runs/:id/rejudge (issue #639)', () => {
  it('re-grades the outputs of a run whose judge failed, without calling the model under test again', async () => {
    const run = await arrangeProducedRun();
    await failEveryJudgeCall(run);
    const before = await prisma.experimentRun.findUniqueOrThrow({ where: { id: run.runId } });
    expect(before.status).toBe('succeeded');
    const outputsBefore = await prisma.evalResult.findMany({ where: { experimentRunId: run.runId }, select: { id: true, output: true } });

    const res = await run.agent.post(`/api/v1/runs/${run.runId}/rejudge`).send({}).expect(202);
    expect(res.body).toEqual({ run_id: run.runId, status: 'running', rejudging: 2 });

    // The run is open again and every verdict is cleared, so finalize waits for the new ones.
    const reopened = await prisma.experimentRun.findUniqueOrThrow({ where: { id: run.runId } });
    expect(reopened.status).toBe('running');
    expect(reopened.endedAt).toBeNull();
    const cleared = await prisma.evalResult.findMany({ where: { experimentRunId: run.runId } });
    expect(cleared.every((r) => r.score === null && r.reason === null && r.judgeTraceId === null)).toBe(true);
    expect(await queuedRejudgeFinalizers(run.runId)).toBe(1);

    // Every judge call goes to the judge model; none goes to the model under test.
    const sent = await drainJudgeQueue(run.resultIds, 90);
    expect(sent).toHaveLength(2);
    // The frozen overall feedback and criteria reach the judge.
    expect(JSON.stringify(sent[0].messages)).toContain('Be brief.');
    expect(JSON.stringify(sent[0].messages)).toContain('reply in third person');

    await processFinalize({ teamId: run.teamId, runId: run.runId });
    const done = await prisma.experimentRun.findUniqueOrThrow({ where: { id: run.runId } });
    expect(done.status).toBe('succeeded');
    expect(done.endedAt).not.toBeNull();
    const after = await prisma.evalResult.findMany({ where: { experimentRunId: run.runId }, select: { id: true, output: true, score: true } });
    expect(after.map((r) => r.score)).toEqual([90, 90]);
    // The paid outputs are the same rows, untouched.
    expect(after.map(({ id, output }) => ({ id, output }))).toEqual(outputsBefore);

    const report = await run.agent.get(`/api/v1/runs/${run.runId}/report`).expect(200);
    expect(report.body.unscoredReason ?? null).toBeNull();
  });

  it('grades against the overall feedback frozen at run start, not the dataset as edited since', async () => {
    const run = await arrangeProducedRun();
    await failEveryJudgeCall(run);
    await run.agent.patch(`/api/v1/datasets/${run.datasetId}`).send({ overall_feedback: 'EDITED AFTER THE RUN' }).expect(200);

    await run.agent.post(`/api/v1/runs/${run.runId}/rejudge`).send({}).expect(202);
    const sent = await drainJudgeQueue(run.resultIds, 70);

    expect(JSON.stringify(sent[0].messages)).toContain('Be brief.');
    expect(JSON.stringify(sent[0].messages)).not.toContain('EDITED AFTER THE RUN');
  });

  it('only_unscored (the default) leaves scored results alone; only_unscored: false re-grades all', async () => {
    const run = await arrangeProducedRun();
    const [scored, unscored] = run.resultIds;
    await runsRepo.writeVerdict(scored, { score: 40, passed: false, reason: 'meh', judgeTraceId: null });
    await runsRepo.writeVerdict(unscored, { score: null, passed: null, reason: 'judge call failed: 429', judgeTraceId: null });
    await processFinalize({ teamId: run.teamId, runId: run.runId });

    const partial = await run.agent.post(`/api/v1/runs/${run.runId}/rejudge`).send({}).expect(202);
    expect(partial.body.rejudging).toBe(1);
    expect((await prisma.evalResult.findUniqueOrThrow({ where: { id: scored } })).score).toBe(40);
    expect(await getJudgeQueue().getJob(judgeJobId(scored))).toBeUndefined();
    await drainJudgeQueue([unscored], 85);
    await processFinalize({ teamId: run.teamId, runId: run.runId });

    const all = await run.agent.post(`/api/v1/runs/${run.runId}/rejudge`).send({ only_unscored: false }).expect(202);
    expect(all.body.rejudging).toBe(2);
    await drainJudgeQueue(run.resultIds, 95);
    await processFinalize({ teamId: run.teamId, runId: run.runId });
    const scores = await prisma.evalResult.findMany({ where: { experimentRunId: run.runId }, orderBy: { createdAt: 'asc' } });
    expect(scores.map((r) => r.score)).toEqual([95, 95]);
  });

  it("replaces a result's completed judge job instead of being silently ignored by BullMQ", async () => {
    const run = await arrangeProducedRun();
    await failEveryJudgeCall(run);
    // Judge jobs keep a fixed id per result and are never removed on completion. An
    // add with that id while the old job still exists is a no-op in BullMQ.
    const queue = getJudgeQueue();
    for (const id of run.resultIds) {
      await queue.add('judge', { teamId: run.teamId, resultId: id, judgeModel: 'stale' }, { jobId: judgeJobId(id) });
    }
    const connection = getRedisConnection().duplicate();
    const worker = new Worker(EVAL_JUDGE_QUEUE, undefined, { connection, autorun: false });
    for (let i = 0; i < run.resultIds.length; i++) {
      const job = await worker.getNextJob('test-token');
      await job!.moveToCompleted('done', 'test-token', false);
    }
    await worker.close();
    await connection.quit();

    await run.agent.post(`/api/v1/runs/${run.runId}/rejudge`).send({}).expect(202);

    for (const id of run.resultIds) {
      const job = await queue.getJob(judgeJobId(id));
      expect(await job!.getState()).toBe('waiting');
      expect(job!.data.judgeModel).toBe('gpt-4o-mini');
    }
  });

  it('is not reaped as stale while an old run is being re-judged', async () => {
    const run = await arrangeProducedRun();
    await failEveryJudgeCall(run);
    // A run from three hours ago: past the reaper's 2-hour window on every timestamp
    // it reads. A re-judge writes verdicts onto these rows and creates none.
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await prisma.$executeRaw`UPDATE experiment_runs SET created_at = ${threeHoursAgo}, started_at = ${threeHoursAgo} WHERE id = ${run.runId}::uuid`;
    await prisma.$executeRaw`UPDATE eval_results SET created_at = ${threeHoursAgo} WHERE experiment_run_id = ${run.runId}::uuid`;

    await run.agent.post(`/api/v1/runs/${run.runId}/rejudge`).send({}).expect(202);
    const reaped = await reapStaleRuns({ staleMinutes: 120 });

    expect(reaped).toBe(0);
    expect((await prisma.experimentRun.findUniqueOrThrow({ where: { id: run.runId } })).status).toBe('running');
  });

  it('refuses a run that is missing cells, since finalize could never settle it', async () => {
    const run = await arrangeProducedRun();
    await failEveryJudgeCall(run);
    // A cell job lost to the stale-run reaper: the run failed with one result short.
    await prisma.evalResult.delete({ where: { id: run.resultIds[1] } });
    await prisma.experimentRun.update({ where: { id: run.runId }, data: { status: 'failed', error: 'stale' } });

    const res = await run.agent.post(`/api/v1/runs/${run.runId}/rejudge`).send({}).expect(409);
    expect(res.body.error.code).toBe('RUN_INCOMPLETE');
    const after = await prisma.experimentRun.findUniqueOrThrow({ where: { id: run.runId } });
    expect(after.status).toBe('failed');
    expect(await getJudgeQueue().getJob(judgeJobId(run.resultIds[0]))).toBeUndefined();
  });

  it('grades a run created before the grading snapshot against its dataset, even after the dataset is deleted', async () => {
    const run = await arrangeProducedRun();
    await failEveryJudgeCall(run);
    await prisma.$executeRaw`UPDATE experiment_runs SET grading_snapshot = NULL WHERE id = ${run.runId}::uuid`;
    await run.agent.delete(`/api/v1/datasets/${run.datasetId}`).expect(200);

    await run.agent.post(`/api/v1/runs/${run.runId}/rejudge`).send({}).expect(202);
    const sent = await drainJudgeQueue(run.resultIds, 80);

    expect(JSON.stringify(sent[0].messages)).toContain('Be brief.');
  });

  it('restores the old verdicts and status when the judge jobs cannot be queued', async () => {
    const run = await arrangeProducedRun();
    for (const id of run.resultIds) {
      await runsRepo.writeVerdict(id, { score: 60, passed: true, reason: 'ok', judgeTraceId: null });
    }
    await processFinalize({ teamId: run.teamId, runId: run.runId });
    const before = await prisma.experimentRun.findUniqueOrThrow({ where: { id: run.runId } });
    // A Redis failure while the jobs are being added.
    const queue = getJudgeQueue();
    jest.spyOn(queue, 'add').mockRejectedValue(new Error('Connection is closed.'));
    jest.spyOn(queue, 'addBulk').mockRejectedValue(new Error('Connection is closed.'));

    await run.agent.post(`/api/v1/runs/${run.runId}/rejudge`).send({ only_unscored: false }).expect(500);

    const after = await prisma.experimentRun.findUniqueOrThrow({ where: { id: run.runId } });
    expect({ status: after.status, startedAt: after.startedAt, endedAt: after.endedAt, error: after.error }).toEqual({
      status: before.status, startedAt: before.startedAt, endedAt: before.endedAt, error: before.error,
    });
    const scores = await prisma.evalResult.findMany({ where: { experimentRunId: run.runId } });
    expect(scores.map((r) => [r.score, r.passed, r.reason])).toEqual([[60, true, 'ok'], [60, true, 'ok']]);
  });

  it('removes the queued judge jobs and restores the run when its finalize job cannot be queued', async () => {
    const run = await arrangeProducedRun();
    for (const id of run.resultIds) {
      await runsRepo.writeVerdict(id, { score: 60, passed: true, reason: 'ok', judgeTraceId: null });
    }
    await processFinalize({ teamId: run.teamId, runId: run.runId });
    jest.spyOn(getRunsQueue(), 'add').mockRejectedValue(new Error('Connection is closed.'));

    await run.agent.post(`/api/v1/runs/${run.runId}/rejudge`).send({ only_unscored: false }).expect(500);

    expect((await prisma.experimentRun.findUniqueOrThrow({ where: { id: run.runId } })).status).toBe('succeeded');
    for (const id of run.resultIds) {
      expect(await getJudgeQueue().getJob(judgeJobId(id))).toBeUndefined();
    }
    const scores = await prisma.evalResult.findMany({ where: { experimentRunId: run.runId } });
    expect(scores.every((r) => r.score === 60 && r.reason === 'ok')).toBe(true);
  });

  it('refuses while a judge job for the run is still pending', async () => {
    const run = await arrangeProducedRun();
    await failEveryJudgeCall(run);
    await getJudgeQueue().add('judge', { teamId: run.teamId, resultId: run.resultIds[0], judgeModel: 'gpt-4o-mini' }, { jobId: judgeJobId(run.resultIds[0]) });

    const res = await run.agent.post(`/api/v1/runs/${run.runId}/rejudge`).send({}).expect(409);
    expect(res.body.error.code).toBe('JUDGE_PENDING');
    expect((await prisma.experimentRun.findUniqueOrThrow({ where: { id: run.runId } })).status).toBe('succeeded');
  });

  it('refuses a run that is still in flight', async () => {
    const run = await arrangeProducedRun();
    const res = await run.agent.post(`/api/v1/runs/${run.runId}/rejudge`).send({}).expect(409);
    expect(res.body.error.code).toBe('RUN_IN_FLIGHT');
  });

  it('answers 200 with nothing queued when every result is already scored', async () => {
    const run = await arrangeProducedRun();
    for (const id of run.resultIds) {
      await runsRepo.writeVerdict(id, { score: 60, passed: true, reason: 'ok', judgeTraceId: null });
    }
    await processFinalize({ teamId: run.teamId, runId: run.runId });

    const res = await run.agent.post(`/api/v1/runs/${run.runId}/rejudge`).send({}).expect(200);
    expect(res.body).toEqual({ run_id: run.runId, status: 'succeeded', rejudging: 0 });
    expect(await queuedRejudgeFinalizers(run.runId)).toBe(0);
  });

  it('validates the body and 404s an unknown run', async () => {
    const run = await arrangeProducedRun();
    await failEveryJudgeCall(run);
    await run.agent.post(`/api/v1/runs/${run.runId}/rejudge`).send({ only_unscored: 'yes' }).expect(400);
    await run.agent.post('/api/v1/runs/00000000-0000-4000-8000-000000000000/rejudge').send({}).expect(404);
  });
});
