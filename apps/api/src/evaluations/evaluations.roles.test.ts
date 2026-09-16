import request from 'supertest';
import { createApp } from '../../app';
import prisma from '../shared/db/client';
import { authedAgent, addUserToTeam, authHeaders, type AuthedAgent, type TestAuthContext } from '../test-utils';
import { getCellsQueue, getRunsQueue, getOptimizeQueue } from './queue/queues';

/**
 * Who may spend the team's gateway budget, and who may delete its evaluation data.
 *
 * Starting an experiment run enqueues one paid provider call per
 * (version × model × example) cell; starting an optimize run adds an optimizer
 * completion on top of a full grid. Both were reachable by `viewer` — the role a
 * team hands to someone who should look and not touch — which meant a read-only
 * member could bill the team for hundreds of completions and delete the datasets
 * those runs evaluate against.
 *
 * The bar is `editor`, matching `POST /runs/:id/promote` and the prompt
 * version-commit route: writing evaluation data is editing work. Reads stay open
 * to every member.
 */
const app = createApp();

beforeEach(async () => {
  // Queues are drained HERE, not in a root `afterAll`. `jest-teardown.ts` registers its
  // own root `afterAll` via `setupFilesAfterEnv`, and Jest runs same-scope hooks in
  // REGISTRATION order — so teardown closes Redis first, and a queue getter running
  // after it silently re-opens the connection that nothing is left to close. The run
  // then passes every assertion and hangs forever on the live handle.
  await Promise.allSettled([
    getCellsQueue().obliterate({ force: true }),
    getRunsQueue().obliterate({ force: true }),
    getOptimizeQueue().obliterate({ force: true }),
  ]);
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    eval_results, experiment_runs, experiments,
    dataset_examples, datasets,
    span_payloads, spans, trace_feedback, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys,
    gateway_model_fallbacks, gateway_models, provider_connections,
    prompt_aliases, prompt_versions, prompts,
    notification_preferences, email_log,
    audit_log, api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
});

/** A prompt, a dataset with one example, a registered model, and an experiment over them. */
async function arrange(agent: AuthedAgent['agent']): Promise<{
  experimentId: string;
  promptId: string;
  datasetId: string;
}> {
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id })
    .expect(201);

  const prompt = (await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
  const version = (
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'hi {{ name }}' }] })
      .expect(201)
  ).body;

  const dataset = (await agent.post('/api/v1/datasets').send({ name: 'greetings' }).expect(201)).body;
  await agent.post(`/api/v1/datasets/${dataset.id}/examples`).send({ input: { name: 'Al' } }).expect(201);

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

  return { experimentId: experiment.id, promptId: prompt.id, datasetId: dataset.id };
}

describe('a viewer cannot spend the team money', () => {
  let owner: AuthedAgent;
  let viewer: TestAuthContext;
  let arranged: Awaited<ReturnType<typeof arrange>>;

  beforeEach(async () => {
    owner = await authedAgent(app);
    arranged = await arrange(owner.agent);
    viewer = await addUserToTeam(app, owner.teamId, 'viewer');
  });

  it('refuses POST /experiments/:id/runs, and queues nothing', async () => {
    const before = (await getCellsQueue().getJobCounts('waiting')).waiting;

    await request(app)
      .post(`/api/v1/experiments/${arranged.experimentId}/runs`)
      .set(authHeaders(viewer))
      .expect(403);

    // The refusal has to be before the work, not after it.
    expect((await getCellsQueue().getJobCounts('waiting')).waiting).toBe(before);
    expect(await prisma.experimentRun.count()).toBe(0);
  });

  it('refuses POST /prompts/:id/optimize', async () => {
    await request(app)
      .post(`/api/v1/prompts/${arranged.promptId}/optimize`)
      .set(authHeaders(viewer))
      .send({ dataset_id: arranged.datasetId, models: ['gpt-4o-mini'], optimizer_model: 'gpt-4o-mini' })
      .expect(403);

    expect(await prisma.experimentRun.count()).toBe(0);
  });

  it('refuses POST /experiments', async () => {
    await request(app)
      .post('/api/v1/experiments')
      .set(authHeaders(viewer))
      .send({ dataset_id: arranged.datasetId, version_ids: [], models: [] })
      .expect(403);
  });
});

describe('a viewer cannot change evaluation data', () => {
  let owner: AuthedAgent;
  let viewer: TestAuthContext;
  let datasetId: string;

  beforeEach(async () => {
    owner = await authedAgent(app);
    viewer = await addUserToTeam(app, owner.teamId, 'viewer');
    datasetId = (await owner.agent.post('/api/v1/datasets').send({ name: 'ds' }).expect(201)).body.id;
  });

  it('refuses to create, edit or delete a dataset', async () => {
    await request(app).post('/api/v1/datasets').set(authHeaders(viewer)).send({ name: 'mine' }).expect(403);
    await request(app).patch(`/api/v1/datasets/${datasetId}`).set(authHeaders(viewer)).send({ name: 'x' }).expect(403);
    await request(app)
      .post(`/api/v1/datasets/${datasetId}/examples`)
      .set(authHeaders(viewer))
      .send({ input: { q: 'hi' } })
      .expect(403);
    await request(app).delete(`/api/v1/datasets/${datasetId}`).set(authHeaders(viewer)).expect(403);

    expect(await prisma.dataset.count()).toBe(1); // still there
  });

  it('still lets a viewer read', async () => {
    await request(app).get('/api/v1/datasets').set(authHeaders(viewer)).expect(200);
    await request(app).get(`/api/v1/datasets/${datasetId}`).set(authHeaders(viewer)).expect(200);
    await request(app).get('/api/v1/experiments').set(authHeaders(viewer)).expect(200);
    await request(app).get('/api/v1/runs').set(authHeaders(viewer)).expect(200);
  });
});

describe('an editor keeps every one of those rights', () => {
  it('may create a dataset, an experiment, and start a run', async () => {
    const owner = await authedAgent(app);
    const arranged = await arrange(owner.agent);
    const editor = await addUserToTeam(app, owner.teamId, 'editor');

    await request(app).post('/api/v1/datasets').set(authHeaders(editor)).send({ name: 'editor-ds' }).expect(201);
    await request(app)
      .post(`/api/v1/experiments/${arranged.experimentId}/runs`)
      .set(authHeaders(editor))
      .expect(202);
  });
});

/**
 * Where the bar sits on an eval rule, and why it is not one bar (issue #510).
 *
 * The split is between a bounded action and a standing one. `preview` judges at
 * most ten spans once and ends; `to-dataset` copies rows the rule has already
 * scored into a dataset an editor could have built by hand. Both are smaller
 * than the 500-cell experiment run an editor may already start, so refusing
 * them read as a bug rather than a policy.
 *
 * Create, update and delete stay at owner or admin. A rule judges live traffic
 * continuously — turning one on changes what the team is billed for from then
 * on, which is a different kind of decision from spending a known amount once.
 */
describe('what an editor may do with an evaluation rule', () => {
  let owner: AuthedAgent;
  let editor: TestAuthContext;
  let ruleId: string;

  beforeEach(async () => {
    owner = await authedAgent(app);
    await arrange(owner.agent);
    editor = await addUserToTeam(app, owner.teamId, 'editor');
    const created = await owner.agent
      .post('/api/v1/eval-rules')
      .send({ name: 'quality gate', criteria: 'answers the question', sampleRate: 1, judgeModel: 'gpt-4o-mini' })
      .expect(201);
    ruleId = created.body.id;
  });

  it('may preview a rule and build a dataset from it — both are bounded, one-off actions', async () => {
    await request(app)
      .post(`/api/v1/eval-rules/${ruleId}/preview`)
      .set(authHeaders(editor))
      .send({ limit: 1 })
      .expect(200);

    await request(app)
      .post(`/api/v1/eval-rules/${ruleId}/to-dataset`)
      .set(authHeaders(editor))
      .send({ datasetName: 'rule failures', threshold: 50 })
      .expect(201);
  });

  it('may not create, change or delete one — those start and stop a standing spend', async () => {
    await request(app)
      .post('/api/v1/eval-rules')
      .set(authHeaders(editor))
      .send({ name: 'another', criteria: 'x', sampleRate: 1, judgeModel: 'gpt-4o-mini' })
      .expect(403);
    await request(app)
      .patch(`/api/v1/eval-rules/${ruleId}`)
      .set(authHeaders(editor))
      .send({ enabled: false })
      .expect(403);
    await request(app).delete(`/api/v1/eval-rules/${ruleId}`).set(authHeaders(editor)).expect(403);
  });

  it('still refuses a viewer both halves', async () => {
    const viewer = await addUserToTeam(app, owner.teamId, 'viewer');
    await request(app)
      .post(`/api/v1/eval-rules/${ruleId}/preview`)
      .set(authHeaders(viewer))
      .send({ limit: 1 })
      .expect(403);
    await request(app).delete(`/api/v1/eval-rules/${ruleId}`).set(authHeaders(viewer)).expect(403);
  });
});

describe('which credential reaches a gated evaluation route', () => {
  /**
   * `requireRole` refuses a caller with no `req.user` BEFORE it looks at any role, and
   * `requireApiKey` leaves `req.user` undefined for a team-scoped key — so gating these
   * routes also closed them to every team key, with a `TEAM_KEY_NOT_PERMITTED` 403.
   *
   * That is the intended design (a team key holds no role, so there is nothing to
   * check), but it is invisible from the route definitions, and the suite above uses
   * only session cookies, so it structurally cannot catch the credential it changes.
   * Both directions are asserted here, and the guides that teach these calls now say
   * which key type to use.
   */
  it('refuses a team-scoped API key and accepts a personal key from an editor', async () => {
    const owner = await authedAgent(app);
    const arranged = await arrange(owner.agent);

    const teamKey: string = (
      await owner.agent.post(`/api/v1/teams/${owner.teamId}/api-keys`).send({ name: 'ci' }).expect(201)
    ).body.key;
    const personalKey: string = (
      await owner.agent.post('/api/v1/api-keys').send({ name: 'mine' }).expect(201)
    ).body.key;

    const teamRes = await request(app)
      .post(`/api/v1/experiments/${arranged.experimentId}/runs`)
      .set('Authorization', `Bearer ${teamKey}`)
      .expect(403);
    expect(teamRes.body.error.code).toBe('TEAM_KEY_NOT_PERMITTED');

    // The same call on a personal key, whose owner holds a role, goes through.
    await request(app)
      .post(`/api/v1/experiments/${arranged.experimentId}/runs`)
      .set('Authorization', `Bearer ${personalKey}`)
      .expect(202);

    // Reads stay open to a team key — only the write routes are gated.
    await request(app).get('/api/v1/datasets').set('Authorization', `Bearer ${teamKey}`).expect(200);
  });
});
