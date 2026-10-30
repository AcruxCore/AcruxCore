import http from 'http';
import type { AddressInfo } from 'net';
import { Worker } from 'bullmq';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../../app';
import prisma from '../shared/db/client';
import { resetAuthTables, signupTestUserWithApiKey } from '../test-utils';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../tools/execute/safe-fetch';
import { processCell, processFinalize, processJudge, processOptimize } from '../evaluations/runs';
import {
  EVAL_CELLS_QUEUE,
  EVAL_JUDGE_QUEUE,
  EVAL_OPTIMIZE_QUEUE,
  EVAL_RUNS_QUEUE,
  getCellsQueue,
  getFlowProducer,
  getJudgeQueue,
  getOptimizeQueue,
  getQueuePrefix,
  getRedisConnection,
  getRunsQueue,
} from '../evaluations/queue';
import { setSelfBaseUrl } from './mcp.types';

const app = createApp();

/** What the fake judge looks for: only the third-person rewrite produces it. */
const GOOD_ANSWER = 'THIRD-PERSON-REPLY';

/** A baseline prompt carrying this makes the fake optimizer draft six very long rewrites. */
const LONG_PROMPT_MARKER = 'LONG-PROMPT';

let server: http.Server;
let origin: string;
let provider: http.Server;
let providerUrl: string;
let apiKey: string;

/** Joins every message's text content, whatever shape it arrived in. */
function textOfMessages(messages: Array<{ content: unknown }>): string {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

/** Wraps assistant text in the OpenAI chat.completion shape the gateway expects. */
function completion(content: string): string {
  return JSON.stringify({
    id: 'gen-1',
    object: 'chat.completion',
    created: 1751536800,
    model: 'fake-upstream',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

/**
 * Answers the three kinds of call an optimize run makes, by reading the request:
 * the optimizer drafts two rewrites (one fixes the prompt, one does not), a cell answers
 * with the good reply only when its prompt asks for the third person, and the judge
 * scores 95 for the good reply and 30 for anything else.
 */
function fakeProviderReply(body: { messages: Array<{ content: unknown }> }): string {
  const text = textOfMessages(body.messages);
  if (text.includes('expert prompt engineer') && text.includes(LONG_PROMPT_MARKER)) {
    // Six long rewrites: together they are far past the MCP text limit.
    return completion(
      JSON.stringify({
        candidates: Array.from({ length: 6 }, (_, i) => ({
          messages: [
            {
              role: 'system',
              content: `${i % 2 === 0 ? 'Answer about {{ name }} in the third person.' : 'Reply to {{ name }}.'} ${'x'.repeat(9000)}`,
            },
          ],
          rationale: `Rewrite ${i}.`,
        })),
      }),
    );
  }
  if (text.includes('expert prompt engineer')) {
    return completion(
      JSON.stringify({
        candidates: [
          {
            messages: [{ role: 'system', content: 'Answer about {{ name }} in the third person.' }],
            rationale: 'The criteria ask for the third person.',
          },
          {
            messages: [{ role: 'system', content: 'Reply to {{ name }}.' }],
            rationale: 'Shorter wording.',
          },
        ],
      }),
    );
  }
  if (text.includes('impartial evaluator')) {
    const good = text.includes(GOOD_ANSWER);
    return completion(
      JSON.stringify({ score: good ? 95 : 30, passed: good, reason: good ? 'third person' : 'first person' }),
    );
  }
  return completion(text.includes('third person') ? GOOD_ANSWER : 'I will help you.');
}

beforeAll(async () => {
  allowLoopbackForTests();
  provider = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fakeProviderReply(JSON.parse(raw)));
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, resolve));
  // `localhost`, not 127.0.0.1: the connection schema refuses a literal loopback IP.
  providerUrl = `http://localhost:${(provider.address() as AddressInfo).port}/v1`;

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setSelfBaseUrl(`${origin}/api/v1`);
});

afterAll(async () => {
  resetSsrfAllowlist();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await prisma.$disconnect();
  await getFlowProducer().close();
  await getRedisConnection().quit();
});

beforeEach(async () => {
  // A job left by an earlier test points at rows the truncate below removes.
  for (const queue of [getOptimizeQueue(), getCellsQueue(), getJudgeQueue(), getRunsQueue()]) {
    await queue.obliterate({ force: true });
  }
  await resetAuthTables();
  apiKey = (await signupTestUserWithApiKey(app)).apiKey;
});

/** Plain REST call with the test key, for arranging what the MCP tools do not create. */
async function rest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

/**
 * Arranges a model on the fake provider, a prompt whose production v1 answers in the
 * first person, and a dataset whose criteria ask for the third person.
 */
async function arrange(): Promise<{ promptId: string; datasetId: string }> {
  const connection = await rest<{ id: string }>('POST', '/gateway/connections', {
    provider: 'openai_compatible',
    label: 'fake',
    apiKey: 'sk-fake-00000000000AB12',
    config: { base_url: providerUrl },
  });
  await rest('POST', '/gateway/models', {
    publicName: 'fake-model',
    upstreamModel: 'fake-upstream',
    credentialId: connection.id,
    inputPricePerM: 1,
    outputPricePerM: 1,
  });

  const prompt = await rest<{ id: string }>('POST', '/prompts', { name: 'bio-writer' });
  await rest('POST', `/prompts/${prompt.id}/versions`, {
    messages: [{ role: 'system', content: 'Answer as {{ name }}.' }],
  });
  await rest('POST', `/prompts/${prompt.id}/aliases/production/promote`, { version_number: 1 });

  const dataset = await rest<{ id: string }>('POST', '/datasets', { name: 'bios' });
  for (const name of ['Al', 'Bo']) {
    await rest('POST', `/datasets/${dataset.id}/examples`, {
      input: { name },
      criteria: 'Write about the person in the third person.',
    });
  }
  return { promptId: prompt.id, datasetId: dataset.id };
}

/**
 * Runs every queued evaluation job in this process, in the order the worker would.
 *
 * The real worker (`apps/worker`) consumes these same queues with these same
 * processors; doing it here keeps the whole run inside the test's database and Redis.
 * Finishing a child job is what releases a Flow's parent finalize job, so the loop
 * repeats until no queue has anything left.
 */
async function drainEvalQueues(): Promise<void> {
  const processors: Array<[string, (data: never) => Promise<void>]> = [
    [EVAL_OPTIMIZE_QUEUE, processOptimize],
    [EVAL_CELLS_QUEUE, processCell],
    [EVAL_JUDGE_QUEUE, processJudge],
    [EVAL_RUNS_QUEUE, processFinalize],
  ];
  const connection = getRedisConnection().duplicate();
  const workers = processors.map(
    ([queue, run]) => [new Worker(queue, undefined, { connection, prefix: getQueuePrefix(), autorun: false }), run] as const,
  );
  try {
    for (let pass = 0; pass < 20; pass++) {
      let ran = 0;
      for (const [worker, run] of workers) {
        for (;;) {
          const job = await worker.getNextJob('drain', { block: false });
          if (!job) break;
          await run(job.data as never);
          await job.moveToCompleted('done', 'drain', false);
          ran++;
        }
      }
      if (ran === 0) return;
    }
    throw new Error('Evaluation queues did not drain in 20 passes.');
  } finally {
    await Promise.all(workers.map(([worker]) => worker.close()));
    await connection.quit();
  }
}

/** Connects the official MCP client to the hosted endpoint with the test key. */
async function connect(): Promise<Client> {
  const client = new Client({ name: 'mcp-optimize-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/api/v1/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
    }),
  );
  return client;
}

/** Calls a tool and returns its text plus whether it failed. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = (result.content[0] as { text: string }).text;
  return { text, isError: Boolean(result.isError) };
}

/** The JSON part of a tool result, after the summary line. */
function payloadOf<T>(text: string): T {
  return JSON.parse(text.slice(text.indexOf('\n\n') + 2)) as T;
}

/** Starts an optimize run through MCP, runs it to completion, and returns its report. */
async function runOptimize(
  client: Client,
  args: Record<string, unknown>,
): Promise<{ runId: string; report: ReportPayload; text: string }> {
  const started = await call(client, 'optimize_prompt', {
    models: ['fake-model'],
    judge_model: 'fake-model',
    draft_count: 2,
    ...args,
  });
  if (started.isError) throw new Error(started.text);
  const runId = payloadOf<{ run_id: string }>(started.text).run_id;
  await drainEvalQueues();
  const reported = await call(client, 'get_optimize_report', { run_id: runId });
  if (reported.isError) throw new Error(reported.text);
  return { runId, report: payloadOf<ReportPayload>(reported.text), text: reported.text };
}

/** The version number an alias of the prompt points at, or null when it does not exist. */
async function aliasVersion(promptId: string, alias: string): Promise<number | null> {
  const row = await prisma.promptAlias.findFirst({ where: { promptId, alias }, include: { version: true } });
  return row?.version.versionNumber ?? null;
}

interface ReportPayload {
  status: string;
  messagesOmitted?: boolean;
  recommended: string | null;
  baseline: Array<{ model: string; avgScore: number }>;
  candidates: Array<{
    candidateId: string;
    label: string;
    beatsBaseline: boolean;
    rationale: string | null;
    messages?: unknown;
    scores: Array<{ model: string; avgScore: number; scoreDelta: number; verdict: string }>;
  }>;
}

describe('optimizer over the hosted MCP endpoint', () => {
  it('starts a run, reports which rewrite beat the baseline, refuses the one that did not, and promotes the winner', async () => {
    const { promptId, datasetId } = await arrange();
    const client = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['optimize_prompt', 'get_optimize_report', 'promote_optimize_candidate']),
      );

      // Start: by prompt NAME, the way an assistant is asked to.
      const started = await call(client, 'optimize_prompt', {
        prompt: 'bio-writer',
        dataset_id: datasetId,
        models: ['fake-model'],
        judge_model: 'fake-model',
        draft_count: 2,
      });
      expect(started.isError).toBe(false);
      const runId = payloadOf<{ run_id: string }>(started.text).run_id;
      expect(started.text).toContain(`Optimize run ${runId} is queued`);

      // Before the worker has run: status only, no invented scores.
      const pending = await call(client, 'get_optimize_report', { run_id: runId });
      expect(pending.text).toContain('is queued. No scores yet');

      await drainEvalQueues();

      const reported = await call(client, 'get_optimize_report', { run_id: runId });
      expect(reported.isError).toBe(false);
      const report = payloadOf<ReportPayload>(reported.text);
      expect(report.status).toBe('succeeded');
      expect(report.baseline).toEqual([expect.objectContaining({ model: 'fake-model', avgScore: 30 })]);

      const [winner, loser] = report.candidates;
      expect(winner).toMatchObject({ label: 'candidate-A', beatsBaseline: true });
      expect(winner.rationale).toBe('The criteria ask for the third person.');
      expect(winner.scores[0]).toMatchObject({ avgScore: 95, scoreDelta: 65, verdict: 'improved' });
      expect(loser).toMatchObject({ label: 'candidate-B', beatsBaseline: false });
      expect(report.recommended).toBe(winner.candidateId);
      expect(reported.text).toContain(`Recommended: candidate-A (candidate_id ${winner.candidateId})`);

      // The rewrite that scored no better is refused, and nothing moves.
      const refused = await call(client, 'promote_optimize_candidate', {
        run_id: runId,
        candidate_id: loser.candidateId,
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('Refused: candidate-B did not beat the baseline');
      expect(await prisma.promptVersion.count({ where: { promptId } })).toBe(1);

      // The winner ships: a new version 2 carrying its messages, with production on it.
      const promoted = await call(client, 'promote_optimize_candidate', {
        run_id: runId,
        candidate_id: winner.candidateId,
      });
      expect(promoted.isError).toBe(false);
      expect(promoted.text).toContain('Promoted candidate-A as version 2; alias "production" now points at it.');

      const production = await prisma.promptAlias.findFirst({
        where: { promptId, alias: 'production' },
        include: { version: true },
      });
      expect(production?.version.versionNumber).toBe(2);
      expect(production?.version.messages).toEqual([
        { role: 'system', content: 'Answer about {{ name }} in the third person.' },
      ]);
    } finally {
      await client.close();
    }
  });

  it('ships a rewrite that did not win only when the caller explicitly overrides', async () => {
    const { promptId, datasetId } = await arrange();
    const client = await connect();
    try {
      const started = await call(client, 'optimize_prompt', {
        prompt: promptId,
        dataset_id: datasetId,
        models: ['fake-model'],
        judge_model: 'fake-model',
        draft_count: 2,
      });
      const runId = payloadOf<{ run_id: string }>(started.text).run_id;
      await drainEvalQueues();
      const report = payloadOf<ReportPayload>((await call(client, 'get_optimize_report', { run_id: runId })).text);
      const loser = report.candidates.find((c) => !c.beatsBaseline)!;

      const promoted = await call(client, 'promote_optimize_candidate', {
        run_id: runId,
        candidate_id: loser.candidateId,
        alias: 'staging',
        promote_without_improvement: true,
      });

      expect(promoted.isError).toBe(false);
      const staging = await prisma.promptAlias.findFirst({
        where: { promptId, alias: 'staging' },
        include: { version: true },
      });
      expect(staging?.version.messages).toEqual([{ role: 'system', content: 'Reply to {{ name }}.' }]);
    } finally {
      await client.close();
    }
  });

  it('refuses to promote from a run that has not finished scoring', async () => {
    const { datasetId } = await arrange();
    const client = await connect();
    try {
      const started = await call(client, 'optimize_prompt', {
        prompt: 'bio-writer',
        dataset_id: datasetId,
        models: ['fake-model'],
        judge_model: 'fake-model',
      });
      const runId = payloadOf<{ run_id: string }>(started.text).run_id;

      const refused = await call(client, 'promote_optimize_candidate', {
        run_id: runId,
        candidate_id: '00000000-0000-4000-8000-000000000000',
      });

      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('is queued, so its rewrites are not fully scored');
    } finally {
      await client.close();
    }
  });
  it('points an ordinary evaluation run back to get_experiment_run', async () => {
    const { promptId, datasetId } = await arrange();
    const versions = await rest<{ data: Array<{ id: string }> }>('GET', `/prompts/${promptId}/versions`);
    const experiment = await rest<{ id: string }>('POST', '/experiments', {
      dataset_id: datasetId,
      version_ids: [versions.data[0].id],
      models: ['fake-model'],
      judge_model: 'fake-model',
    });
    const run = await rest<{ run_id: string }>('POST', `/experiments/${experiment.id}/runs`);
    const client = await connect();
    try {
      const result = await call(client, 'get_optimize_report', { run_id: run.run_id });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('is an evaluation run, not an optimize run');
    } finally {
      await client.close();
    }
  });

  // The run was scored against staging, so the default target is staging, not production.
  it('moves the alias the run was scored against when no alias is given', async () => {
    const { promptId, datasetId } = await arrange();
    await rest('POST', `/prompts/${promptId}/versions`, {
      messages: [{ role: 'system', content: 'Answer as {{ name }}, briefly.' }],
    });
    await rest('POST', `/prompts/${promptId}/aliases/staging/promote`, { version_number: 2 });
    const client = await connect();
    try {
      const { runId, report } = await runOptimize(client, {
        prompt: promptId,
        dataset_id: datasetId,
        alias: 'staging',
      });
      const winner = report.candidates.find((c) => c.beatsBaseline)!;

      const promoted = await call(client, 'promote_optimize_candidate', {
        run_id: runId,
        candidate_id: winner.candidateId,
      });

      expect(promoted.isError).toBe(false);
      expect(promoted.text).toContain('alias "staging" now points at it');
      expect(await aliasVersion(promptId, 'staging')).toBe(3);
      expect(await aliasVersion(promptId, 'production')).toBe(1);
    } finally {
      await client.close();
    }
  });

  it('refuses to replace a version the run never scored, unless the caller overrides', async () => {
    const { promptId, datasetId } = await arrange();
    const client = await connect();
    try {
      const { runId, report } = await runOptimize(client, { prompt: promptId, dataset_id: datasetId });
      const winner = report.candidates.find((c) => c.beatsBaseline)!;

      // After the run, someone ships a hand-written v2 to production.
      await rest('POST', `/prompts/${promptId}/versions`, {
        messages: [{ role: 'system', content: 'Hand-tuned: write about {{ name }} in the third person.' }],
      });
      await rest('POST', `/prompts/${promptId}/aliases/production/promote`, { version_number: 2 });

      const refused = await call(client, 'promote_optimize_candidate', {
        run_id: runId,
        candidate_id: winner.candidateId,
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('alias "production" now points at version 2');
      expect(await aliasVersion(promptId, 'production')).toBe(2);

      // A different alias than the one scored is the same case: staging points at v2.
      await rest('POST', `/prompts/${promptId}/aliases/staging/promote`, { version_number: 2 });
      const otherAlias = await call(client, 'promote_optimize_candidate', {
        run_id: runId,
        candidate_id: winner.candidateId,
        alias: 'staging',
      });
      expect(otherAlias.isError).toBe(true);
      expect(otherAlias.text).toContain('alias "staging" now points at version 2');

      const overridden = await call(client, 'promote_optimize_candidate', {
        run_id: runId,
        candidate_id: winner.candidateId,
        promote_without_improvement: true,
      });
      expect(overridden.isError).toBe(false);
      expect(await aliasVersion(promptId, 'production')).toBe(3);
    } finally {
      await client.close();
    }
  });

  it('keeps every candidate id readable when the rewrites are too long for one result', async () => {
    const { datasetId } = await arrange();
    const prompt = await rest<{ id: string }>('POST', '/prompts', { name: 'long-writer' });
    await rest('POST', `/prompts/${prompt.id}/versions`, {
      messages: [{ role: 'system', content: `${LONG_PROMPT_MARKER} Answer as {{ name }}.` }],
    });
    await rest('POST', `/prompts/${prompt.id}/aliases/production/promote`, { version_number: 1 });
    const client = await connect();
    try {
      const { runId, report, text } = await runOptimize(client, {
        prompt: prompt.id,
        dataset_id: datasetId,
        draft_count: 6,
      });

      expect(report.candidates).toHaveLength(6);
      expect(report.candidates.every((c) => /^[0-9a-f-]{36}$/.test(c.candidateId))).toBe(true);
      expect(report.messagesOmitted).toBe(true);
      expect(text).toContain('call get_optimize_report again with candidate_id');

      // One candidate at a time fits, with its full messages.
      const one = await call(client, 'get_optimize_report', {
        run_id: runId,
        candidate_id: report.candidates[5].candidateId,
      });
      expect(one.isError).toBe(false);
      const detail = payloadOf<{ candidate: { candidateId: string; messages: Array<{ content: string }> } }>(one.text);
      expect(detail.candidate.candidateId).toBe(report.candidates[5].candidateId);
      expect(detail.candidate.messages[0].content.length).toBeGreaterThan(9000);
    } finally {
      await client.close();
    }
  });

  it('still reports the scores when one candidate cannot be read', async () => {
    const { promptId, datasetId } = await arrange();
    const client = await connect();
    try {
      const { runId, report } = await runOptimize(client, { prompt: promptId, dataset_id: datasetId });
      await prisma.promptCandidate.delete({ where: { id: report.candidates[1].candidateId } });

      const reported = await call(client, 'get_optimize_report', { run_id: runId });

      expect(reported.isError).toBe(false);
      const after = payloadOf<ReportPayload>(reported.text);
      expect(after.candidates.map((c) => c.label)).toEqual(['candidate-A', 'candidate-B']);
      expect(after.candidates[0].rationale).toBe('The criteria ask for the third person.');
      expect(after.candidates[1]).toMatchObject({ rationale: null, scores: [expect.objectContaining({ avgScore: 30 })] });
    } finally {
      await client.close();
    }
  });
  // Not an optimizer tool, but this is the suite that drives a run to completion.
  it('get_experiment_run counts the results a finished run produced', async () => {
    const { datasetId } = await arrange();
    const client = await connect();
    try {
      const started = await call(client, 'optimize_prompt', {
        prompt: 'bio-writer',
        dataset_id: datasetId,
        models: ['fake-model'],
        judge_model: 'fake-model',
        draft_count: 2,
      });
      const runId = payloadOf<{ run_id: string }>(started.text).run_id;
      await drainEvalQueues();

      const result = await call(client, 'get_experiment_run', { run_id: runId });

      // Baseline + two rewrites, each over two examples.
      expect(result.text.split('\n')[0]).toBe(`Run ${runId} is succeeded with 6 result(s).`);
    } finally {
      await client.close();
    }
  });
});
