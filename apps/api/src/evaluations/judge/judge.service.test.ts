import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { RunsRepository } from '../runs/runs.repository';
import { JudgeService } from './judge.service';
import { authedAgent } from '../../test-utils';

const app = createApp();
const runsRepo = new RunsRepository();
const judgeService = new JudgeService();

function mockFetchOnce(body: unknown, ok = true, status = 200): void {
  jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response);
}

/** Builds an OpenAI-shaped chat.completion whose assistant content is the given verdict, JSON-stringified. */
function cannedJudge(verdict: { score: number; passed: boolean; reason: string }): unknown {
  return cannedRaw(JSON.stringify(verdict));
}

/** Builds an OpenAI-shaped chat.completion whose assistant content is the given raw string. */
function cannedRaw(content: string): unknown {
  return {
    id: 'chatcmpl-judge',
    object: 'chat.completion',
    created: 1751536800,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  };
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
 * Arranges everything a judge test needs: a registered model, a prompt with a
 * committed v1 promoted to production, a dataset (optionally with
 * `overallFeedback`) with one example (optionally with `criteria`), an
 * experiment tying them together, a queued run, and one `eval_result` row
 * carrying a produced `output` — the row `scoreResult` will judge.
 */
async function arrangeResult(
  agent: ReturnType<typeof request.agent>,
  teamId: string,
  opts: { criteria?: string; overallFeedback?: string; output?: string } = {},
): Promise<{ resultId: string }> {
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

  const dataset = (
    await agent
      .post('/api/v1/datasets')
      .send({ name: 'greetings', ...(opts.overallFeedback !== undefined ? { overall_feedback: opts.overallFeedback } : {}) })
      .expect(201)
  ).body;
  const example = (
    await agent
      .post(`/api/v1/datasets/${dataset.id}/examples`)
      .send({ input: { name: 'Al' }, ...(opts.criteria !== undefined ? { criteria: opts.criteria } : {}) })
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

  const run = await runsRepo.createRun(teamId, experiment.id, {
    exampleSnapshot: [{ exampleId: example.id, input: { name: 'Al' }, criteria: opts.criteria ?? null }],
    grid: [{ cellKey: 'v1|gpt-4o-mini', variantKind: 'version', promptVersionId: version.id, versionLabel: 'v1', model: 'gpt-4o-mini' }],
  });

  const result = await runsRepo.writeResult({
    teamId,
    experimentRunId: run.id,
    datasetExampleId: example.id,
    variantKind: 'version',
    promptVersionId: version.id,
    variantLabel: 'v1',
    model: 'gpt-4o-mini',
    output: opts.output ?? 'Hi Al!',
    traceId: undefined,
  });

  return { resultId: result.id };
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
});

describe('JudgeService.scoreResult', () => {
  it('scores an eval_result: canned judge JSON -> score/passed/reason + judgeTraceId persisted', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { resultId } = await arrangeResult(agent, teamId, { criteria: 'reply in third person' });

    mockFetchOnce(cannedJudge({ score: 80, passed: true, reason: 'third person' }));
    await judgeService.scoreResult(teamId, resultId);

    const row = await prisma.evalResult.findUnique({ where: { id: resultId } });
    expect(row!.score).toBe(80);
    expect(row!.passed).toBe(true);
    expect(row!.reason).toBe('third person');
    expect(row!.judgeTraceId).not.toBeNull();
  });

  it('grades against the run-FROZEN criteria/overallFeedback, not the live (since-edited) dataset', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { resultId } = await arrangeResult(agent, teamId, { criteria: 'FROZEN reply in third person' });

    // Simulate the dataset being edited AFTER this run snapshotted its examples.
    await prisma.datasetExample.updateMany({ data: { criteria: 'EDITED reply in first person' } });
    await prisma.dataset.updateMany({ data: { overallFeedback: 'EDITED overall feedback' } });

    // Capture exactly what is sent to the provider so we can assert which
    // rubric text the judge compiled into its prompt.
    let sentBody = '';
    jest.spyOn(global, 'fetch').mockImplementationOnce((async (_url: unknown, init: unknown) => {
      sentBody = String((init as { body?: unknown } | undefined)?.body ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => cannedJudge({ score: 70, passed: true, reason: 'ok' }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch);

    // The judge job carries the values frozen at run-start (here: the original
    // criteria, and no overall feedback), NOT the edited live ones.
    await judgeService.scoreResult(teamId, resultId, {
      criteria: 'FROZEN reply in third person',
      overallFeedback: null,
    });

    expect(sentBody).toContain('FROZEN reply in third person');
    expect(sentBody).not.toContain('EDITED reply in first person');
    expect(sentBody).not.toContain('EDITED overall feedback');

    const row = await prisma.evalResult.findUnique({ where: { id: resultId } });
    expect(row!.score).toBe(70);
  });

  it('includes frozen history in the judge call when present', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { resultId } = await arrangeResult(agent, teamId, { criteria: 'be nice' });

    let sentBody = '';
    jest.spyOn(global, 'fetch').mockImplementationOnce((async (_url: unknown, init: unknown) => {
      sentBody = String((init as { body?: unknown } | undefined)?.body ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => cannedJudge({ score: 90, passed: true, reason: 'ok' }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch);

    await judgeService.scoreResult(teamId, resultId, {
      criteria: 'be nice',
      overallFeedback: null,
      history: [{ role: 'user', content: 'turn 1' }],
    });

    expect(sentBody).toContain('Conversation so far');
    expect(sentBody).toContain('turn 1');
  });

  it('malformed judge output -> unscored after one retry, run still usable', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { resultId } = await arrangeResult(agent, teamId, { criteria: 'reply in third person' });

    mockFetchOnce(cannedRaw('garbage')); // attempt 1
    mockFetchOnce(cannedRaw('still garbage')); // retry
    await judgeService.scoreResult(teamId, resultId);

    const row = await prisma.evalResult.findUnique({ where: { id: resultId } });
    expect(row!.score).toBeNull();
    expect(row!.reason).toMatch(/parse/i);
  });

  it('an example with no per-example criteria but a dataset overall_feedback still gets scored', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { resultId } = await arrangeResult(agent, teamId, { overallFeedback: 'be concise' });

    mockFetchOnce(cannedJudge({ score: 90, passed: true, reason: 'concise enough' }));
    await judgeService.scoreResult(teamId, resultId);

    const row = await prisma.evalResult.findUnique({ where: { id: resultId } });
    expect(row!.score).toBe(90);
    expect(row!.passed).toBe(true);
    expect(row!.reason).toBe('concise enough');
  });

  it('neither criteria nor overall_feedback -> left unscored but marked judged, no gateway call made', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { resultId } = await arrangeResult(agent, teamId);

    const fetchSpy = jest.spyOn(global, 'fetch');
    await judgeService.scoreResult(teamId, resultId);

    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await prisma.evalResult.findUnique({ where: { id: resultId } });
    expect(row!.score).toBeNull();
    // Task 4: the skip path still writes a `reason` marker (rather than
    // leaving the row completely untouched) so finalize.processor can tell
    // "judged, nothing to score" apart from "not yet judged".
    expect(row!.reason).not.toBeNull();
  });

  it('a tiny team budget caps judge calls: the gateway call errors, no bypass', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { resultId } = await arrangeResult(agent, teamId, { criteria: 'reply in third person' });

    // Team-wide 'total' budget already at its cap -> precheckBudgets rejects
    // before any provider fetch happens.
    await agent.post('/api/v1/gateway/budgets').send({ virtualKeyId: null, period: 'total', limitUsd: 0.01 }).expect(201);
    await prisma.budget.updateMany({ where: { teamId, virtualKeyId: null }, data: { spendUsd: '0.01' } });

    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(judgeService.scoreResult(teamId, resultId)).rejects.toThrow(/budget/i);
    expect(fetchSpy).not.toHaveBeenCalled();

    const row = await prisma.evalResult.findUnique({ where: { id: resultId } });
    expect(row!.score).toBeNull();
  });
});
