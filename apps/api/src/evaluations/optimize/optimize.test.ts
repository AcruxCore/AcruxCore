import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { processOptimize, processCell } from '../runs';
import { getFlowProducer, getRedisConnection } from '../queue';
import { authedAgent } from '../../test-utils';

/** One `exampleSnapshot` entry as frozen onto `ExperimentRun` (see `runs.types.ts`'s `RunSnapshotExample`). */
interface FrozenExample {
  exampleId: string;
  input: Record<string, unknown>;
  criteria: string | null;
}

/** One `grid` cell as frozen onto `ExperimentRun` by `processOptimize`. */
interface FrozenGridCell {
  cellKey: string;
  variantKind: string;
  variantLabel: string;
  model: string;
  promptCandidateId?: string;
  promptVersionId?: string;
}

const app = createApp();

/** Builds an OpenAI-shaped chat.completion whose assistant content is the optimizer's JSON candidate list. */
function cannedOptimizer(candidates: Array<{ messages: Array<{ role: string; content: string }>; rationale: string }>): unknown {
  return {
    id: 'chatcmpl-optimize',
    object: 'chat.completion',
    created: 1751536800,
    model: 'gpt-4o-mini',
    choices: [
      { index: 0, message: { role: 'assistant', content: JSON.stringify({ candidates }) }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 40, total_tokens: 90 },
  };
}

/** Canned OpenAI-shaped chat.completion for a plain (non-optimizer) cell call. */
const CANNED_CELL_OPENAI = {
  id: 'chatcmpl-cell',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Al replied in third person.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
};

function mockFetchOnce(body: unknown, ok = true, status = 200): void {
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
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
 * Arranges everything an optimize test needs: a registered `gpt-4o-mini`
 * model, a prompt with a committed v1 ("Answer as {{ name }}") promoted to
 * production, and a dataset with two criteria-bearing examples (the
 * "failing cases" the optimizer is asked to fix).
 */
async function arrangeOptimizeBasics(
  agent: ReturnType<typeof request.agent>,
): Promise<{ promptId: string; datasetId: string }> {
  const credId = await createConnection(agent);
  await registerModel(agent, credId);

  const prompt = (await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
  await agent
    .post(`/api/v1/prompts/${prompt.id}/versions`)
    .send({ messages: [{ role: 'system', content: 'Answer as {{ name }}' }] })
    .expect(201);
  await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

  const dataset = (await agent.post('/api/v1/datasets').send({ name: 'cases' }).expect(201)).body;
  await agent
    .post(`/api/v1/datasets/${dataset.id}/examples`)
    .send({ input: { name: 'Al' }, criteria: 'reply in third person' })
    .expect(201);
  await agent
    .post(`/api/v1/datasets/${dataset.id}/examples`)
    .send({ input: { name: 'Bo' }, criteria: 'no first person' })
    .expect(201);

  return { promptId: prompt.id, datasetId: dataset.id };
}

async function truncateTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    prompt_candidates, eval_results, experiment_runs, experiments,
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

  // Same reasoning as run-engine.test.ts's afterAll: this file also opens a
  // real ioredis connection via the memoized getFlowProducer()/
  // getRedisConnection() singletons (processOptimize enqueues a Flow), and a
  // separate Jest test file gets its own fresh module registry, so this
  // teardown is not shared with run-engine.test.ts's — it must close its own
  // connection or Jest hangs after this file's tests finish.
  await getFlowProducer().close();
  await getRedisConnection().quit();
});

describe('POST /prompts/:promptId/optimize + processOptimize', () => {
  it('drafts candidates and runs them + production baseline through the grid', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const { promptId, datasetId } = await arrangeOptimizeBasics(agent);

    mockFetchOnce(
      cannedOptimizer([
        { messages: [{ role: 'system', content: 'Answer about {{ name }} in third person' }], rationale: 'third person' },
        { messages: [{ role: 'system', content: 'Reply re {{ name }}, no first person' }], rationale: 'no I' },
      ]),
    );

    const run = (
      await agent
        .post(`/api/v1/prompts/${promptId}/optimize`)
        .send({ dataset_id: datasetId, models: ['gpt-4o-mini'], draft_count: 2 })
        .expect(202)
    ).body;
    expect(run.status).toBe('queued');

    const runRowBefore = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });
    const experimentId = runRowBefore!.experimentId;

    await processOptimize({
      teamId,
      userId,
      promptId,
      experimentId,
      runId: run.run_id,
      datasetId,
      models: ['gpt-4o-mini'],
      draftCount: 2,
    });

    const candidates = await prisma.promptCandidate.findMany({ where: { experimentRunId: run.run_id } });
    expect(candidates.length).toBe(2);
    expect(candidates.map((c) => c.label).sort()).toEqual(['candidate-A', 'candidate-B']);

    const runRow = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });
    const grid = runRow!.grid as Array<{ variantKind: string; variantLabel: string; model: string }>;
    expect(grid.some((c) => c.variantKind === 'candidate')).toBe(true);
    // No `alias` was requested, so the baseline resolves to the prompt's
    // `production` alias (which arrangeOptimizeBasics points at v1) — the
    // production-alias-first default (design "Alias-based baseline", FAQ Q21).
    expect(grid.some((c) => c.variantLabel === 'production')).toBe(true);
    // 2 candidates + 1 baseline, x 1 model = 3 grid cells.
    expect(grid.length).toBe(3);

    // The run-history list reads `kind` off exactly this grid, so an optimize
    // run must show up as one rather than as a plain evaluation.
    const historyRow = (await agent.get('/api/v1/runs').expect(200)).body.data[0];
    expect(historyRow.id).toBe(run.run_id);
    expect(historyRow.kind).toBe('optimize');
    expect(historyRow.variantCount).toBe(3);
    expect(historyRow.modelCount).toBe(1);
  });

  it("threads a dataset example's frozen history into the optimizer's own gateway call", async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'support' }).expect(201)).body;
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Reply to {{ name }}' }] })
      .expect(201);
    await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

    const dataset = (await agent.post('/api/v1/datasets').send({ name: 'cases-with-history' }).expect(201)).body;
    await agent
      .post(`/api/v1/datasets/${dataset.id}/examples`)
      .send({
        input: { name: 'Al' },
        criteria: 'too curt',
        history: [{ role: 'user', content: 'My order is late' }, { role: 'assistant', content: 'What is your order number?' }],
      })
      .expect(201);

    mockFetchOnce(cannedOptimizer([{ messages: [{ role: 'user', content: 'Reply warmly to {{ name }}' }], rationale: 'warmer tone' }]));

    const run = (
      await agent
        .post(`/api/v1/prompts/${prompt.id}/optimize`)
        .send({ dataset_id: dataset.id, models: ['gpt-4o-mini'], draft_count: 1 })
        .expect(202)
    ).body;
    const runRowBefore = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });

    await processOptimize({
      teamId,
      userId,
      promptId: prompt.id,
      experimentId: runRowBefore!.experimentId,
      runId: run.run_id,
      datasetId: dataset.id,
      models: ['gpt-4o-mini'],
      draftCount: 1,
    });

    const fetchMock = global.fetch as unknown as jest.Mock;
    const sentBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    const userMessage = sentBody.messages.find((m: { role: string }) => m.role === 'user');
    expect(userMessage.content).toContain('Conversation history leading up to this case');
    expect(userMessage.content).toContain('My order is late');
  });

  it('optimizer returns one valid + one template-broken candidate -> exactly 1 candidate stored', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const { promptId, datasetId } = await arrangeOptimizeBasics(agent);

    mockFetchOnce(
      cannedOptimizer([
        { messages: [{ role: 'system', content: 'Answer about {{ name }} in third person' }], rationale: 'third person' },
        { messages: [{ role: 'system', content: 'broken {{ unclosed' }], rationale: 'broken' },
      ]),
    );

    const run = (
      await agent
        .post(`/api/v1/prompts/${promptId}/optimize`)
        .send({ dataset_id: datasetId, models: ['gpt-4o-mini'], draft_count: 2 })
        .expect(202)
    ).body;

    const runRowBefore = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });
    const experimentId = runRowBefore!.experimentId;

    await processOptimize({
      teamId,
      userId,
      promptId,
      experimentId,
      runId: run.run_id,
      datasetId,
      models: ['gpt-4o-mini'],
      draftCount: 2,
    });

    const candidates = await prisma.promptCandidate.findMany({ where: { experimentRunId: run.run_id } });
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.rationale).toBe('third person');
  });

  it('optimizer returns only invalid candidates -> run is marked failed', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const { promptId, datasetId } = await arrangeOptimizeBasics(agent);

    mockFetchOnce(
      cannedOptimizer([
        { messages: [{ role: 'system', content: 'broken {{ unclosed' }], rationale: 'broken1' },
        { messages: [{ role: 'system', content: 'also broken {{ unclosed too' }], rationale: 'broken2' },
      ]),
    );

    const run = (
      await agent
        .post(`/api/v1/prompts/${promptId}/optimize`)
        .send({ dataset_id: datasetId, models: ['gpt-4o-mini'], draft_count: 2 })
        .expect(202)
    ).body;

    const runRowBefore = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });
    const experimentId = runRowBefore!.experimentId;

    await processOptimize({
      teamId,
      userId,
      promptId,
      experimentId,
      runId: run.run_id,
      datasetId,
      models: ['gpt-4o-mini'],
      draftCount: 2,
    });

    const candidates = await prisma.promptCandidate.findMany({ where: { experimentRunId: run.run_id } });
    expect(candidates.length).toBe(0);

    const runRow = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });
    expect(runRow!.status).toBe('failed');
    // The error names *why* each candidate was dropped, not just that none
    // survived: "no valid candidates" alone hid a real case where the optimizer
    // returned good rewrites that were all rejected on a variable-set mismatch.
    expect(runRow!.error).toContain('optimizer produced no valid candidates');
    expect(runRow!.error).toContain('candidate 1: template does not parse');
    expect(runRow!.endedAt).not.toBeNull();
  });

  it('draft_count above the hard cap (6) is rejected with a 422', async () => {
    const { agent } = await authedAgent(app);
    const { promptId, datasetId } = await arrangeOptimizeBasics(agent);

    await agent
      .post(`/api/v1/prompts/${promptId}/optimize`)
      .send({ dataset_id: datasetId, models: ['gpt-4o-mini'], draft_count: 10 })
      .expect(422);
  });

  it('returns 404 for a cross-team promptId', async () => {
    const { agent: agentA } = await authedAgent(app);
    const { promptId, datasetId } = await arrangeOptimizeBasics(agentA);

    const { agent: agentB } = await authedAgent(app);
    await agentB
      .post(`/api/v1/prompts/${promptId}/optimize`)
      .send({ dataset_id: datasetId, models: ['gpt-4o-mini'] })
      .expect(404);
  });

  it('processOptimize rejects a foreign-team promptId even when the run itself is owned by the caller\'s team (defense-in-depth pre-check)', async () => {
    // The HTTP path can never actually reach processOptimize with a foreign
    // promptId -- OptimizeService.startOptimize already verifies ownership
    // before enqueueing (see the previous test). This test instead calls
    // processOptimize directly with a hand-built OptimizeJobData to prove its
    // OWN pre-check (mirroring RunsService.resolveGrid's) is what would catch
    // a cross-tenant promptId if that upstream guarantee were ever broken by
    // a future change -- not merely relying on the later
    // versionsRepo.findByIdForTeam catch, which would also (coincidentally)
    // 404 here since team B's production version does not belong to team A.
    const { agent: agentA, teamId: teamIdA, userId: userIdA } = await authedAgent(app);
    const { promptId: promptIdA, datasetId: datasetIdA } = await arrangeOptimizeBasics(agentA);

    const { agent: agentB } = await authedAgent(app);
    const { promptId: promptIdB } = await arrangeOptimizeBasics(agentB);

    mockFetchOnce(
      cannedOptimizer([{ messages: [{ role: 'system', content: 'irrelevant {{ name }}' }], rationale: 'n/a' }]),
    );

    const run = (
      await agentA
        .post(`/api/v1/prompts/${promptIdA}/optimize`)
        .send({ dataset_id: datasetIdA, models: ['gpt-4o-mini'], draft_count: 1 })
        .expect(202)
    ).body;
    const runRow = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });

    await expect(
      processOptimize({
        teamId: teamIdA,
        userId: userIdA,
        promptId: promptIdB, // belongs to team B, not teamIdA
        experimentId: runRow!.experimentId,
        runId: run.run_id,
        datasetId: datasetIdA,
        models: ['gpt-4o-mini'],
        draftCount: 1,
      }),
    ).rejects.toThrow(`Prompt ${promptIdB} not found`);
  });

  it('processCell renders and records a candidate cell from the optimizer grid (E6 Task 4)', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const { promptId, datasetId } = await arrangeOptimizeBasics(agent);

    mockFetchOnce(
      cannedOptimizer([
        { messages: [{ role: 'system', content: 'Answer about {{ name }} in third person' }], rationale: 'third person' },
        { messages: [{ role: 'system', content: 'Reply re {{ name }}, no first person' }], rationale: 'no I' },
      ]),
    );

    const run = (
      await agent
        .post(`/api/v1/prompts/${promptId}/optimize`)
        .send({ dataset_id: datasetId, models: ['gpt-4o-mini'], draft_count: 2 })
        .expect(202)
    ).body;

    await processOptimize({
      teamId,
      userId,
      promptId,
      experimentId: (await prisma.experimentRun.findUnique({ where: { id: run.run_id } }))!.experimentId,
      runId: run.run_id,
      datasetId,
      models: ['gpt-4o-mini'],
      draftCount: 2,
    });

    const runRow = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });
    const grid = runRow!.grid as unknown as FrozenGridCell[];
    const candidateCell = grid.find((c) => c.variantKind === 'candidate' && c.variantLabel === 'candidate-A');
    expect(candidateCell).toBeDefined();
    expect(candidateCell!.promptCandidateId).toBeDefined();

    const candidateA = await prisma.promptCandidate.findUnique({ where: { id: candidateCell!.promptCandidateId! } });
    expect(candidateA!.label).toBe('candidate-A');

    const exampleSnapshot = runRow!.exampleSnapshot as unknown as FrozenExample[];
    const firstExample = exampleSnapshot[0]!;

    // Fresh response for the CELL's own gateway call (distinct from the
    // optimizer's canned response above) — proves the assertions below read
    // the request this call actually sent, not a stale response body.
    mockFetchOnce(CANNED_CELL_OPENAI);

    await processCell({
      teamId,
      runId: run.run_id,
      cellKey: candidateCell!.cellKey,
      variantKind: 'candidate',
      promptCandidateId: candidateCell!.promptCandidateId,
      variantLabel: candidateCell!.variantLabel,
      model: candidateCell!.model,
      exampleId: firstExample.exampleId,
    });

    const result = await prisma.evalResult.findFirst({
      where: {
        experimentRunId: run.run_id,
        variantLabel: 'candidate-A',
        model: 'gpt-4o-mini',
        datasetExampleId: firstExample.exampleId,
      },
    });
    expect(result).not.toBeNull();
    expect(result!.variantKind).toBe('candidate');
    expect(result!.promptCandidateId).toBe(candidateA!.id);
    expect(result!.promptVersionId).toBeNull();
    expect(result!.output).not.toBeNull();

    // Prove the CANDIDATE's own template (not the production template, which
    // never mentions "third person") was actually rendered and sent to the
    // gateway for this cell.
    const fetchMock = global.fetch as unknown as jest.Mock;
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!;
    const sentBody = JSON.parse((lastCall[1] as RequestInit).body as string);
    expect(JSON.stringify(sentBody.messages)).toContain('third person');
    expect(JSON.stringify(sentBody.messages)).toContain('Al');
  });

  it('includes a prompt-mismatch warning but still starts the run when the dataset was built from a different prompt', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    // Prompt A: the one the dataset's feedback actually came from.
    const promptA = (await agent.post('/api/v1/prompts').send({ name: 'prompt-a' }).expect(201)).body;
    await agent
      .post(`/api/v1/prompts/${promptA.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] })
      .expect(201);
    await agent.post(`/api/v1/prompts/${promptA.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

    mockFetchOnce(CANNED_CELL_OPENAI);
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'prompt-a', alias: 'production', variables: { name: 'Al' } } })
      .expect(200);

    const trace = await prisma.trace.findFirst({ where: { teamId } });
    const fb = (
      await agent.post(`/api/v1/traces/${trace!.id}/feedback`).send({ rating: -1, comment: 'too curt' }).expect(201)
    ).body;
    const dataset = (
      await agent
        .post('/api/v1/datasets/from-feedback')
        .send({ name: 'from-prompt-a', feedback_ids: [fb.id] })
        .expect(201)
    ).body;

    // Prompt B: what we're about to (wrongly) optimize with prompt A's feedback.
    const promptB = (await agent.post('/api/v1/prompts').send({ name: 'prompt-b' }).expect(201)).body;
    await agent
      .post(`/api/v1/prompts/${promptB.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Greet {{ name }}' }] })
      .expect(201);
    await agent.post(`/api/v1/prompts/${promptB.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

    const run = (
      await agent
        .post(`/api/v1/prompts/${promptB.id}/optimize`)
        .send({ dataset_id: dataset.id, models: ['gpt-4o-mini'] })
        .expect(202)
    ).body;

    expect(run.status).toBe('queued');
    expect(run.prompt_mismatch_warning.mismatched_prompts).toEqual([
      { prompt_id: promptA.id, name: 'prompt-a', example_count: 1 },
    ]);
  });

  it('omits the mismatch warning when the dataset has no prompt-sourced examples', async () => {
    // arrangeOptimizeBasics adds its examples via POST /datasets/:id/examples
    // (manual examples), so every sourcePromptVersionId is null — this only
    // exercises checkPromptMismatch's early `versionIds.length === 0` return,
    // not the "examples matched the target prompt" branch. See the next test
    // for that branch.
    const { agent } = await authedAgent(app);
    const { promptId, datasetId } = await arrangeOptimizeBasics(agent);

    const run = (
      await agent
        .post(`/api/v1/prompts/${promptId}/optimize`)
        .send({ dataset_id: datasetId, models: ['gpt-4o-mini'] })
        .expect(202)
    ).body;

    expect(run.prompt_mismatch_warning).toBeUndefined();
  });

  it('omits the mismatch warning when the dataset was built from feedback on the same prompt being optimized', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    // Prompt A: both the feedback's source AND the optimize target — so
    // every example's sourcePromptVersionId resolves to promptId === targetPromptId,
    // exercising checkPromptMismatch's `info.promptId === targetPromptId -> continue` branch.
    const promptA = (await agent.post('/api/v1/prompts').send({ name: 'prompt-a-self' }).expect(201)).body;
    await agent
      .post(`/api/v1/prompts/${promptA.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] })
      .expect(201);
    await agent.post(`/api/v1/prompts/${promptA.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

    mockFetchOnce(CANNED_CELL_OPENAI);
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'prompt-a-self', alias: 'production', variables: { name: 'Al' } } })
      .expect(200);

    const trace = await prisma.trace.findFirst({ where: { teamId } });
    const fb = (
      await agent.post(`/api/v1/traces/${trace!.id}/feedback`).send({ rating: -1, comment: 'too curt' }).expect(201)
    ).body;
    const dataset = (
      await agent
        .post('/api/v1/datasets/from-feedback')
        .send({ name: 'from-prompt-a-self', feedback_ids: [fb.id] })
        .expect(201)
    ).body;

    const run = (
      await agent
        .post(`/api/v1/prompts/${promptA.id}/optimize`)
        .send({ dataset_id: dataset.id, models: ['gpt-4o-mini'] })
        .expect(202)
    ).body;

    expect(run.prompt_mismatch_warning).toBeUndefined();
  });

  it('resolves the baseline via a named alias, not a hardcoded production, and labels the grid cell with it', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const { promptId, datasetId } = await arrangeOptimizeBasics(agent);

    // Move `staging` to a second version that differs from `production` (still v1).
    await agent
      .post(`/api/v1/prompts/${promptId}/versions`)
      .send({ messages: [{ role: 'system', content: 'Answer as {{ name }}, staging edition' }] })
      .expect(201);
    await agent.post(`/api/v1/prompts/${promptId}/aliases/staging/promote`).send({ version_number: 2 }).expect(200);

    mockFetchOnce(cannedOptimizer([{ messages: [{ role: 'system', content: 'Rewritten for {{ name }}' }], rationale: 'x' }]));

    const run = (
      await agent
        .post(`/api/v1/prompts/${promptId}/optimize`)
        .send({ dataset_id: datasetId, models: ['gpt-4o-mini'], draft_count: 1, alias: 'staging' })
        .expect(202)
    ).body;

    const runRowBefore = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });
    await processOptimize({
      teamId,
      userId,
      promptId,
      experimentId: runRowBefore!.experimentId,
      runId: run.run_id,
      datasetId,
      models: ['gpt-4o-mini'],
      draftCount: 1,
      alias: 'staging',
    });

    const runRow = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });
    const grid = runRow!.grid as unknown as FrozenGridCell[];
    expect(grid.some((c) => c.variantLabel === 'staging')).toBe(true);
    expect(grid.some((c) => c.variantLabel === 'production')).toBe(false);
  });

  it('defaults to the production alias (not latest) when no alias is given, even if a newer version was committed since', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const { promptId, datasetId } = await arrangeOptimizeBasics(agent);

    // v2 committed, but production alias still points at v1 — the default
    // must resolve to production (v1), not silently follow "latest" to v2.
    // This is the exact scenario FAQ Q21 fixed: a plain "latest" default
    // would otherwise pick whatever the user just committed, which is the
    // single most common version to be testing, and silently drop the
    // baseline cell entirely when that version is also the one under test.
    await agent
      .post(`/api/v1/prompts/${promptId}/versions`)
      .send({ messages: [{ role: 'system', content: 'Answer as {{ name }}, v2' }] })
      .expect(201);

    mockFetchOnce(cannedOptimizer([{ messages: [{ role: 'system', content: 'Rewritten for {{ name }}' }], rationale: 'x' }]));

    const run = (
      await agent
        .post(`/api/v1/prompts/${promptId}/optimize`)
        .send({ dataset_id: datasetId, models: ['gpt-4o-mini'], draft_count: 1 })
        .expect(202)
    ).body;

    const runRowBefore = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });
    await processOptimize({
      teamId,
      userId,
      promptId,
      experimentId: runRowBefore!.experimentId,
      runId: run.run_id,
      datasetId,
      models: ['gpt-4o-mini'],
      draftCount: 1,
    });

    const runRow = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });
    const grid = runRow!.grid as unknown as FrozenGridCell[];
    expect(grid.some((c) => c.variantLabel === 'production')).toBe(true);
    expect(grid.some((c) => c.variantLabel === 'v2')).toBe(false);
  });
});

/**
 * Drafts one optimize run (2 candidates) against an already-arranged
 * prompt + dataset, and returns the run id + `candidate-A`'s row (queried
 * straight from Prisma — promoting a candidate never depends on its cells
 * having been scored, only on the drafted row existing). Split out from
 * {@link arrangeOptimizeRunWithCandidate} so a test can draft a SECOND run
 * against the same prompt/dataset without re-registering the gateway
 * model (registering the same publicName twice for one team 500s). Module-level
 * (not nested in a single `describe`) so both the promote (E6 Task 5) and
 * candidate-detail (E7 Task 5) test blocks can reuse it.
 */
async function draftOptimizeRun(
  agent: ReturnType<typeof request.agent>,
  teamId: string,
  userId: string,
  promptId: string,
  datasetId: string,
): Promise<{ runId: string; candidateId: string }> {
  mockFetchOnce(
    cannedOptimizer([
      { messages: [{ role: 'system', content: 'Answer about {{ name }} in third person' }], rationale: 'third person' },
      { messages: [{ role: 'system', content: 'Reply re {{ name }}, no first person' }], rationale: 'no I' },
    ]),
  );

  const run = (
    await agent
      .post(`/api/v1/prompts/${promptId}/optimize`)
      .send({ dataset_id: datasetId, models: ['gpt-4o-mini'], draft_count: 2 })
      .expect(202)
  ).body;

  const runRowBefore = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });

  await processOptimize({
    teamId,
    userId,
    promptId,
    experimentId: runRowBefore!.experimentId,
    runId: run.run_id,
    datasetId,
    models: ['gpt-4o-mini'],
    draftCount: 2,
  });

  const candidateA = await prisma.promptCandidate.findFirst({
    where: { experimentRunId: run.run_id, label: 'candidate-A' },
  });

  return { runId: run.run_id, candidateId: candidateA!.id };
}

/**
 * Arranges a prompt + dataset (`arrangeOptimizeBasics`) and drafts one
 * optimize run against them, returning everything a promote test needs.
 */
async function arrangeOptimizeRunWithCandidate(
  agent: ReturnType<typeof request.agent>,
  teamId: string,
  userId: string,
): Promise<{ promptId: string; runId: string; candidateId: string }> {
  const { promptId, datasetId } = await arrangeOptimizeBasics(agent);
  const { runId, candidateId } = await draftOptimizeRun(agent, teamId, userId, promptId, datasetId);
  return { promptId, runId, candidateId };
}

describe('POST /runs/:id/promote (E6 Task 5)', () => {

  it('promotes a candidate: creates version N+1 with its messages and moves production alias', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const { promptId, runId, candidateId } = await arrangeOptimizeRunWithCandidate(agent, teamId, userId);

    const candidateRow = await prisma.promptCandidate.findUnique({ where: { id: candidateId } });

    const before = (await agent.get(`/api/v1/prompts/${promptId}/versions`).expect(200)).body;

    const res = await agent
      .post(`/api/v1/runs/${runId}/promote`)
      .send({ prompt_candidate_id: candidateId })
      .expect(200);

    expect(res.body.version.versionNumber).toBe(2);
    expect(res.body.version.messages).toEqual(candidateRow!.messages);

    const after = (await agent.get(`/api/v1/prompts/${promptId}/versions`).expect(200)).body;
    expect(after.data.length).toBe(before.data.length + 1); // a new immutable version

    const prod = (await agent.get(`/api/v1/prompts/${promptId}/aliases`).expect(200)).body.find(
      (a: { alias: string }) => a.alias === 'production',
    );
    expect(prod.versionNumber).toBe(res.body.version.versionNumber);
  });

  it('promotes to a non-default alias when one is given', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const { promptId, runId, candidateId } = await arrangeOptimizeRunWithCandidate(agent, teamId, userId);

    const res = await agent
      .post(`/api/v1/runs/${runId}/promote`)
      .send({ prompt_candidate_id: candidateId, alias: 'staging' })
      .expect(200);

    expect(res.body.alias.alias).toBe('staging');

    const staging = (await agent.get(`/api/v1/prompts/${promptId}/aliases`).expect(200)).body.find(
      (a: { alias: string }) => a.alias === 'staging',
    );
    expect(staging.versionNumber).toBe(res.body.version.versionNumber);

    // production is untouched by a staging promote
    const prod = (await agent.get(`/api/v1/prompts/${promptId}/aliases`).expect(200)).body.find(
      (a: { alias: string }) => a.alias === 'production',
    );
    expect(prod.versionNumber).toBe(1);
  });

  it('403 without promote-right; no version created', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const { promptId, runId, candidateId } = await arrangeOptimizeRunWithCandidate(agent, teamId, userId);

    const before = (await agent.get(`/api/v1/prompts/${promptId}/versions`).expect(200)).body;

    // Downgrade this same session's own membership to 'viewer' — same
    // pattern `aliases.test.ts` uses for its promote-right 403 test, since a
    // real second-user invite flow is not needed to exercise the guard.
    await prisma.teamMember.update({
      where: { userId_teamId: { userId, teamId } },
      data: { role: 'viewer' },
    });

    const res = await agent
      .post(`/api/v1/runs/${runId}/promote`)
      .send({ prompt_candidate_id: candidateId })
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');

    const after = (await agent.get(`/api/v1/prompts/${promptId}/versions`).expect(200)).body;
    expect(after.data.length).toBe(before.data.length);
  });

  it('no auto-promotion: after a completed optimize run with no promote call, production alias is unchanged', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const { promptId } = await arrangeOptimizeRunWithCandidate(agent, teamId, userId);

    const prod = (await agent.get(`/api/v1/prompts/${promptId}/aliases`).expect(200)).body.find(
      (a: { alias: string }) => a.alias === 'production',
    );
    expect(prod.versionNumber).toBe(1); // still v1 — optimize alone never moves an alias

    const versions = (await agent.get(`/api/v1/prompts/${promptId}/versions`).expect(200)).body;
    expect(versions.data.length).toBe(1); // no version was created by drafting candidates either
  });

  it('team B cannot promote team A\'s candidate via team A\'s run — 404', async () => {
    const { agent: agentA, teamId: teamIdA, userId: userIdA } = await authedAgent(app);
    const { runId: runIdA, candidateId: candidateIdA } = await arrangeOptimizeRunWithCandidate(agentA, teamIdA, userIdA);

    const { agent: agentB } = await authedAgent(app);
    const res = await agentB
      .post(`/api/v1/runs/${runIdA}/promote`)
      .send({ prompt_candidate_id: candidateIdA })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('a candidate drafted for a different run (same team) cannot be promoted through this run\'s id — 404', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const { promptId, datasetId } = await arrangeOptimizeBasics(agent);
    const { runId: runId1 } = await draftOptimizeRun(agent, teamId, userId, promptId, datasetId);
    const { candidateId: candidateId2 } = await draftOptimizeRun(agent, teamId, userId, promptId, datasetId);

    // candidateId2 belongs to the SECOND optimize run, not runId1
    const res = await agent
      .post(`/api/v1/runs/${runId1}/promote`)
      .send({ prompt_candidate_id: candidateId2 })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /runs/:id/candidates/:candidateId (E7 Task 5)', () => {
  it('returns the candidate\'s real messages/rationale (happy path)', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const { promptId, runId, candidateId } = await arrangeOptimizeRunWithCandidate(agent, teamId, userId);

    const candidateRow = await prisma.promptCandidate.findUnique({ where: { id: candidateId } });

    const res = await agent.get(`/api/v1/runs/${runId}/candidates/${candidateId}`).expect(200);

    expect(res.body.id).toBe(candidateId);
    expect(res.body.promptId).toBe(promptId);
    expect(res.body.messages).toEqual(candidateRow!.messages);
    expect(res.body.rationale).toBe(candidateRow!.rationale);
    expect(res.body.label).toBe('candidate-A');
    expect(res.body.createdAt).toBeDefined();
  });

  it('does not require promote-right — a viewer can read a candidate', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const { runId, candidateId } = await arrangeOptimizeRunWithCandidate(agent, teamId, userId);

    // Downgrade this same session's own membership to 'viewer' — same
    // pattern the promote 403 test above uses.
    await prisma.teamMember.update({
      where: { userId_teamId: { userId, teamId } },
      data: { role: 'viewer' },
    });

    await agent.get(`/api/v1/runs/${runId}/candidates/${candidateId}`).expect(200);
  });

  it('team B cannot read team A\'s candidate via team A\'s run — 404', async () => {
    const { agent: agentA, teamId: teamIdA, userId: userIdA } = await authedAgent(app);
    const { runId: runIdA, candidateId: candidateIdA } = await arrangeOptimizeRunWithCandidate(agentA, teamIdA, userIdA);

    const { agent: agentB } = await authedAgent(app);
    const res = await agentB.get(`/api/v1/runs/${runIdA}/candidates/${candidateIdA}`).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('a candidate drafted for a different run (same team) 404s through this run\'s id', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const { promptId, datasetId } = await arrangeOptimizeBasics(agent);
    const { runId: runId1 } = await draftOptimizeRun(agent, teamId, userId, promptId, datasetId);
    const { candidateId: candidateId2 } = await draftOptimizeRun(agent, teamId, userId, promptId, datasetId);

    // candidateId2 belongs to the SECOND optimize run, not runId1
    const res = await agent.get(`/api/v1/runs/${runId1}/candidates/${candidateId2}`).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
