import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Worker } from 'bullmq';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../tools/execute/safe-fetch';
import { getQueuePrefix, getRedisConnection, perTeamInFlightCap, withTeamSlot } from '../queue';
import { getOnlineEvalQueue, ONLINE_EVAL_QUEUE, type OnlineEvalJobData } from './online-eval.queue';
import { invalidateRuleCache, processOnlineEval } from './online-eval.processor';

const app = createApp();

/** How many chat completions the fake judge upstream has answered. */
let judgeCalls = 0;
let server: http.Server;
let origin: string;
let worker: Worker<OnlineEvalJobData> | null = null;

beforeAll(async () => {
  allowLoopbackForTests();
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      judgeCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `judge-${judgeCalls}`,
          object: 'chat.completion',
          model: 'judge-m',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify({ score: 90, passed: true, reason: 'ok' }) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
  // `localhost`, not 127.0.0.1: the connection schema refuses a literal loopback IP.
  await new Promise<void>((resolve) => server.listen(0, resolve));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  judgeCalls = 0;
  invalidateRuleCache();
  await getOnlineEvalQueue().obliterate({ force: true });
});

afterEach(async () => {
  await worker?.close();
  worker = null;
});

afterAll(async () => {
  resetSsrfAllowlist();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await getOnlineEvalQueue().close();
});

/** One OTLP/JSON export holding `copies` copies of the same `llm` span. */
function otlpExport(traceIdHex: string, spanIdHex: string, copies: number): Record<string, unknown> {
  const span = {
    traceId: traceIdHex,
    spanId: spanIdHex,
    name: 'chat gpt-4o-mini',
    startTimeUnixNano: '1700000000000000000',
    endTimeUnixNano: '1700000000500000000',
    attributes: [
      { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
      { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o-mini' } },
      { key: 'gen_ai.output.messages', value: { stringValue: 'Paris' } },
    ],
  };
  return {
    resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans: Array.from({ length: copies }, () => span) }] }],
  };
}

/** Starts a consumer of the real online-eval queue, wired the way apps/worker wires it. */
function startOnlineEvalWorker(): Worker<OnlineEvalJobData> {
  const concurrency = 2;
  return new Worker<OnlineEvalJobData>(
    ONLINE_EVAL_QUEUE,
    withTeamSlot(ONLINE_EVAL_QUEUE, (job) => processOnlineEval(job.data), { maxPerTeam: perTeamInFlightCap(concurrency) }),
    { connection: getRedisConnection(), prefix: getQueuePrefix(), concurrency },
  );
}

/** Waits until the online-eval queue has nothing waiting, delayed or running, twice in a row. */
async function drained(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let idle = 0;
  while (Date.now() < deadline) {
    const c = await getOnlineEvalQueue().getJobCounts('waiting', 'active', 'delayed', 'prioritized');
    idle = c.waiting + c.active + c.delayed + c.prioritized === 0 ? idle + 1 : 0;
    if (idle >= 3) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('online-eval queue did not drain');
}

describe('online-eval daily limit counts judge calls, not distinct spans', () => {
  it('judges a span re-sent many times exactly once, and still scores a fresh span', async () => {
    const { agent, teamId } = await authedAgent(app);
    const conn = await agent
      .post('/api/v1/gateway/connections')
      .send({
        provider: 'openai_compatible',
        label: 'judge upstream',
        apiKey: 'sk-test-00000000000AB12',
        config: { base_url: `${origin}/v1` },
      })
      .expect(201);
    await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'judge-m', upstreamModel: 'judge-m', credentialId: conn.body.id, inputPricePerM: 1, outputPricePerM: 1 })
      .expect(201);
    const rule = (
      await agent
        .post('/api/v1/eval-rules')
        .send({ name: 'geo', criteria: 'names the right city', sampleRate: 1, dailyLimit: 2, judgeModel: 'judge-m' })
        .expect(201)
    ).body;
    invalidateRuleCache();
    worker = startOnlineEvalWorker();

    const traceHex = randomBytes(16).toString('hex');
    const spanHex = randomBytes(8).toString('hex');
    // Six copies of one span in one export, then the same span re-sent three more times.
    await agent.post('/api/v1/traces/otlp').send(otlpExport(traceHex, spanHex, 6)).expect(200);
    await drained();
    for (let i = 0; i < 3; i++) {
      await agent.post('/api/v1/traces/otlp').send(otlpExport(traceHex, spanHex, 1)).expect(200);
      await drained();
    }
    expect(judgeCalls).toBe(1);

    // A fresh span is still enqueued and judged: the dedupe must not stop real work.
    await agent.post('/api/v1/traces/otlp').send(otlpExport(randomBytes(16).toString('hex'), randomBytes(8).toString('hex'), 1)).expect(200);
    await drained();
    expect(judgeCalls).toBe(2);

    const scores = await prisma.evalRuleScore.findMany({ where: { ruleId: rule.id, teamId } });
    expect(scores).toHaveLength(2);
    expect(scores.every((s) => s.score === 90)).toBe(true);
  });
});
