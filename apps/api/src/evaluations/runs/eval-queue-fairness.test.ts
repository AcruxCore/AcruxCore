import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Worker, type Job } from 'bullmq';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../tools/execute/safe-fetch';
import {
  EVAL_CELLS_QUEUE,
  getCellsQueue,
  getJudgeQueue,
  getQueuePrefix,
  getRedisConnection,
  getRunsQueue,
  evalCallDeadlineMs,
  perTeamInFlightCap,
  withTeamSlot,
  type CellJobData,
} from '../queue';
import { processCell } from './cell.processor';

const app = createApp();

/** Each upstream request: the path prefix it came in on (one per team) and when. */
let arrivals: Array<{ route: string; at: number }> = [];
/** How long each route's fake upstream waits before answering, in ms. */
const ROUTE_DELAY_MS: Record<string, number> = { fast: 0, slow: 1000, hang: 4000 };
const pendingTimers = new Set<NodeJS.Timeout>();
/** Upstream calls open right now, and the most ever open at once, per route. */
let inFlight: Record<string, number> = {};
let peakInFlight: Record<string, number> = {};
let server: http.Server;
let origin: string;
const workers: Worker[] = [];
const savedEnv = { ...process.env };

beforeAll(async () => {
  allowLoopbackForTests();
  server = http.createServer((req, res) => {
    const route = (req.url ?? '').split('/')[1] ?? '';
    req.resume();
    req.on('end', () => {
      arrivals.push({ route, at: Date.now() });
      inFlight[route] = (inFlight[route] ?? 0) + 1;
      peakInFlight[route] = Math.max(peakInFlight[route] ?? 0, inFlight[route]!);
      res.on('close', () => {
        inFlight[route] = (inFlight[route] ?? 1) - 1;
      });
      // "blip": the provider's own gateway answers its first two calls with an instant 504,
      // the way a briefly overloaded upstream does, then recovers.
      if (route === 'blip' && arrivals.filter((x) => x.route === 'blip').length <= 2) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"upstream overloaded"}}');
        return;
      }
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        if (res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'gen-1',
            object: 'chat.completion',
            model: 'm',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          }),
        );
      }, ROUTE_DELAY_MS[route] ?? 0);
      pendingTimers.add(timer);
    });
  });
  // `localhost`, not 127.0.0.1: the connection schema refuses a literal loopback IP.
  await new Promise<void>((resolve) => server.listen(0, resolve));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  arrivals = [];
  offers = [];
  inFlight = {};
  peakInFlight = {};
  await Promise.all([
    getCellsQueue().obliterate({ force: true }),
    getRunsQueue().obliterate({ force: true }),
    getJudgeQueue().obliterate({ force: true }),
  ]);
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.close(true)));
  process.env = { ...savedEnv };
});

afterAll(async () => {
  for (const t of pendingTimers) clearTimeout(t);
  resetSsrfAllowlist();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Signs up a team whose model `m` is served by the fake upstream under `route`, and
 * starts a run of `examples` cells through `POST /experiments/:id/runs`, the real path.
 */
async function startRun(route: string, examples: number): Promise<{ teamId: string; runId: string; startedAt: number }> {
  const { agent, teamId } = await authedAgent(app);
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({
      provider: 'openai_compatible',
      label: route,
      apiKey: 'sk-test-00000000000AB12',
      config: { base_url: `${origin}/${route}/v1` },
    })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: 'm', upstreamModel: 'm', credentialId: conn.body.id, inputPricePerM: 1, outputPricePerM: 1 })
    .expect(201);
  const prompt = (await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
  const version = (
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] })
      .expect(201)
  ).body;
  const dataset = (await agent.post('/api/v1/datasets').send({ name: 'greetings' }).expect(201)).body;
  await agent
    .post(`/api/v1/datasets/${dataset.id}/examples/bulk`)
    .send({ examples: Array.from({ length: examples }, (_, i) => ({ input: { name: `n${i}` }, criteria: 'Greets them.' })) })
    .expect(201);
  const experiment = (
    await agent
      .post('/api/v1/experiments')
      .send({ dataset_id: dataset.id, prompt_id: prompt.id, version_ids: [version.id], models: ['m'], judge_model: 'm' })
      .expect(201)
  ).body;
  const startedAt = Date.now();
  const run = (await agent.post(`/api/v1/experiments/${experiment.id}/runs`).send({}).expect(202)).body;
  return { teamId, runId: run.run_id, startedAt };
}

/** Every time a cell worker was handed a job, parked or run; read by the churn test. */
let offers: number[] = [];

/**
 * The cell worker, wired the way apps/worker wires it, at concurrency 2 (a per-team cap of
 * 1). Each call stands for one worker process.
 */
function startCellWorker(): Worker<CellJobData> {
  const concurrency = 2;
  const gated = withTeamSlot(EVAL_CELLS_QUEUE, (job: Job<CellJobData>) => processCell(job.data), {
    maxPerTeam: perTeamInFlightCap(concurrency),
    // A shorter re-offer delay than the 2 s default only keeps team A's parked cells
    // from stretching the test; it changes no ordering.
    retryDelayMs: 300,
  });
  const worker = new Worker<CellJobData>(
    EVAL_CELLS_QUEUE,
    (job, token) => {
      offers.push(Date.now());
      return gated(job, token);
    },
    { connection: getRedisConnection(), prefix: getQueuePrefix(), concurrency },
  );
  workers.push(worker);
  return worker;
}

async function waitFor<T>(read: () => Promise<T> | T, done: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const resultCount = (runId: string) => () => prisma.evalResult.count({ where: { experimentRunId: runId } });

/** Every failed cell job of one run. */
async function failedCells(runId: string) {
  return (await getCellsQueue().getFailed()).filter((j) => j.data.runId === runId);
}

describe('eval cell queue: per-team fairness', () => {
  it("one team's slow backlog does not hold another team's cell back", async () => {
    startCellWorker();
    const a = await startRun('slow', 4);
    // Let team A's cells take every worker slot first.
    await waitFor(() => arrivals.filter((x) => x.route === 'slow').length, (n) => n >= 1, 2000);
    const b = await startRun('fast', 1);

    const bCall = await waitFor(() => arrivals.find((x) => x.route === 'fast'), (x) => x !== undefined, 8000);
    expect(bCall).toBeDefined();
    // Team A's four 1 s cells two at a time would hold B back about 2 s.
    expect(bCall!.at - b.startedAt).toBeLessThan(800);
    expect(await waitFor(resultCount(b.runId), (n) => n === 1, 2000)).toBe(1);

    // A is slowed to its share, not starved: every one of its cells still finishes.
    expect(await waitFor(resultCount(a.runId), (n) => n === 4, 15_000)).toBe(4);
  }, 30_000);

  it('a timed-out cell is not retried against the same upstream', async () => {
    process.env.GATEWAY_CHAIN_DEADLINE_MS = '500';
    startCellWorker();
    const c = await startRun('hang', 1);

    const failed = await waitFor(() => failedCells(c.runId), (f) => f.length === 1, 6000);
    expect(failed).toHaveLength(1);
    // Room for BullMQ's 1 s and 2 s retry backoff to have fired, had the cell been retried.
    await new Promise((r) => setTimeout(r, 3500));
    expect(arrivals.filter((x) => x.route === 'hang')).toHaveLength(1);
    const [job] = await failedCells(c.runId);
    expect(job.attemptsMade).toBe(1);
  }, 20_000);

  it("retries a cell whose provider answered a quick 504, since nothing held the slot", async () => {
    startCellWorker();
    const c = await startRun('blip', 1);

    // The gateway's own retry meets both 504s; BullMQ's next attempt then succeeds.
    expect(await waitFor(resultCount(c.runId), (n) => n === 1, 8000)).toBe(1);
    expect(await failedCells(c.runId)).toHaveLength(0);
  }, 20_000);

  it("does not cycle a team's whole backlog through delayed while it waits for its slot", async () => {
    startCellWorker();
    await startRun('slow', 20);
    // After the first second the backlog has been parked once; from then on a parked cell
    // should come back about as fast as the team's slot frees, not every few hundred ms.
    await new Promise((r) => setTimeout(r, 1000));
    const from = Date.now();
    await new Promise((r) => setTimeout(r, 2000));
    const steady = offers.filter((t) => t >= from).length;
    // One 1 s cell at a time is about 2 runs in 2 s; allow generous slack for re-offers.
    expect(steady).toBeLessThan(15);
  }, 20_000);

  it('caps a team per worker process, so a second process adds to its throughput', async () => {
    // Two processes at concurrency 2: one team gets one slot in each.
    startCellWorker();
    startCellWorker();
    const run = await startRun('slow', 6);

    expect(await waitFor(resultCount(run.runId), (n) => n === 6, 12_000)).toBe(6);
    // Two cells ran at once, one per process, and never more.
    expect(peakInFlight['slow']).toBe(2);
  }, 30_000);

  it('adds no eval deadline of its own unless EVAL_CALL_DEADLINE_MS is set', () => {
    // Unset, an eval call runs under the gateway's own deadline like every other call,
    // so a slow but healthy judge or reasoning model is not cut off early. The per-team
    // slot cap is what keeps one slow team from holding every shared slot.
    delete process.env.EVAL_CALL_DEADLINE_MS;
    expect(evalCallDeadlineMs()).toBeUndefined();
    process.env.EVAL_CALL_DEADLINE_MS = '20000';
    expect(evalCallDeadlineMs()).toBe(20_000);
  });

  it("a cell's model call gives up at EVAL_CALL_DEADLINE_MS, well before the gateway's own timeout", async () => {
    process.env.EVAL_CALL_DEADLINE_MS = '500';
    startCellWorker();
    const startedAt = Date.now();
    const d = await startRun('hang', 1);

    // The upstream answers after 4 s; without a deadline the cell would wait for it.
    const failed = await waitFor(() => failedCells(d.runId), (f) => f.length === 1, 2500);
    expect(failed).toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(3500);
    expect(await resultCount(d.runId)()).toBe(0);
  }, 20_000);
});
