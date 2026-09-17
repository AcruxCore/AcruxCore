import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../app';
import { authedAgent, type AuthedAgent } from '../../test-utils/auth';
import { mountedRoutes, routeKey } from '../../test-utils/routes';
import prisma from '../db/client';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../tools/execute/safe-fetch';

/**
 * No route that takes a resource id in its URL will serve that id to a team that
 * does not own it.
 *
 * Of the ~200 Prisma calls across the 42 repositories, 75 carry no team filter of
 * their own. They follow a convention stated in `connections.repository.ts`:
 * "Ownership must already be verified by the caller." Three audit sweeps read the
 * domains one at a time and found the convention honoured every time. Nothing
 * enforced it — which means it held by the care of whoever wrote each file, and a
 * new repository method copied from a neighbour inherits the convention only if
 * its author noticed the convention exists.
 *
 * So this walks the real mounted router tree, and for every route carrying a
 * parameter, has team B ask for team A's object. The exhaustiveness assertion is
 * the point: a route added next year is either given an entry here or fails the
 * first test in this file. A checklist cannot do that.
 *
 * Why 404 and not 403: a 403 on an object you do not own confirms the object
 * exists. Every resource route below therefore answers exactly as it would for an
 * id that was never issued. `/teams/:id/*` is the documented exception — see
 * TEAM_SCOPED below, which asserts its own, stricter, property instead.
 *
 * **What this file cannot see.** It walks the router, so it only ever sees an id
 * that arrives in a URL. Every cross-tenant defect this sweep found arrived in a
 * request BODY instead, where there is no route to carry a check — three of them,
 * each with its own test at the bottom of this file. The generated half of that
 * problem lives in `../security/body-borne-ids.test.ts`, which accounts for every
 * UUID field in every request schema. Passing this file is not on its own a
 * statement that team isolation holds.
 */

const app = createApp();

// Two teams' fixtures, a run that has to be enqueued, and ~90 probe requests, all
// against a real database on a single worker.
jest.setTimeout(300_000);

/** Every id team A owns, and the handful of names its routes are addressed by. */
interface Fixture {
  promptId: string;
  promptName: string;
  versionId: string;
  toolId: string;
  secretId: string;
  datasetId: string;
  exampleId: string;
  connectionId: string;
  modelId: string;
  modelName: string;
  virtualKeyId: string;
  budgetId: string;
  evalRuleId: string;
  experimentId: string;
  runId: string;
  traceId: string;
  sessionId: string;
  feedbackId: string;
  viewId: string;
  apiKeyId: string;
  teamApiKeyId: string;
  inviteId: string;
  gatewayRequestId: string;
  teamId: string;
  userId: string;
}

/**
 * Creates one of every addressable resource for a team, entirely through the API.
 *
 * Arranging by calling the API rather than inserting rows is what makes the
 * result meaningful: an id that real signup, real validation and real service
 * code produced is the id an attacker would actually hold.
 *
 * @param a - An authenticated agent.
 * @param tag - Short suffix making every name unique across the two teams.
 * @returns The team's fixture ids.
 */
async function buildFixture(a: AuthedAgent, tag: string, upstreamUrl: string): Promise<Fixture> {
  const S = tag.toUpperCase();
  const promptName = `xt-prompt-${tag}`;
  const modelName = `xt-model-${tag}`;

  const prompt = await a.agent.post('/api/v1/prompts').send({ name: promptName }).expect(201);
  const version = await a.agent
    .post(`/api/v1/prompts/${prompt.body.id}/versions`)
    .send({ messages: [{ role: 'user', content: 'hello {{ name }}' }] })
    .expect(201);
  await a.agent
    .post(`/api/v1/prompts/${prompt.body.id}/aliases/production/promote`)
    .send({ version_number: 1 })
    .expect(200);

  const tool = await a.agent.post('/api/v1/tools').send({ name: `xt_tool_${tag}` }).expect(201);
  await a.agent
    .post(`/api/v1/tools/${tool.body.id}/versions`)
    .send({ parametersSchema: { type: 'object', properties: {} }, executor: { type: 'client' } })
    .expect(201);
  await a.agent
    .post(`/api/v1/tools/${tool.body.id}/aliases/production/promote`)
    .send({ version_number: 1 })
    .expect(200);
  await a.agent
    .put(`/api/v1/prompts/${prompt.body.id}/tools/${tool.body.id}`)
    .send({ tool_alias: 'production' })
    .expect(200);

  const secret = await a.agent
    .post('/api/v1/secrets/')
    .send({ name: `XT_SECRET_${S}`, value: 'plaintext-value' })
    .expect(201);

  const dataset = await a.agent.post('/api/v1/datasets/').send({ name: `xt-dataset-${tag}` }).expect(201);
  const example = await a.agent
    .post(`/api/v1/datasets/${dataset.body.id}/examples`)
    .send({ input: { name: 'world' } })
    .expect(201);

  // Pointed at a local stand-in rather than a real provider: the only thing this
  // fixture needs from a completion is the gateway_requests row it writes, and a
  // suite that reaches api.openai.com to get one fails whenever the network does.
  const connection = await a.agent
    .post('/api/v1/gateway/connections/')
    .send({
      provider: 'openai_compatible',
      label: `xt-conn-${tag}`,
      apiKey: 'sk-not-a-real-key',
      config: { base_url: upstreamUrl },
    })
    .expect(201);
  const model = await a.agent
    .post('/api/v1/gateway/models/')
    .send({ publicName: modelName, upstreamModel: 'gpt-4o-mini', credentialId: connection.body.id })
    .expect(201);
  const virtualKey = await a.agent.post('/api/v1/gateway/keys').send({ name: `xt-key-${tag}` }).expect(201);
  const budget = await a.agent
    .post('/api/v1/gateway/budgets/')
    .send({ period: 'day', limitUsd: 5 })
    .expect(201);

  const evalRule = await a.agent
    .post('/api/v1/eval-rules/')
    .send({ name: `xt-rule-${tag}`, criteria: 'Is the answer correct?', judgeModel: modelName })
    .expect(201);

  const experiment = await a.agent
    .post('/api/v1/experiments/')
    .send({
      dataset_id: dataset.body.id,
      prompt_id: prompt.body.id,
      version_ids: [version.body.id],
      models: [modelName],
    })
    .expect(201);
  // 202: the grid is persisted synchronously, the cells run on the worker. The
  // run id is addressable either way, which is all this suite needs.
  const run = await a.agent.post(`/api/v1/experiments/${experiment.body.id}/runs`).send({}).expect(202);

  const now = new Date().toISOString();
  const sessionId = `xt-session-${tag}`;
  const ingest = await a.agent
    .post('/api/v1/traces')
    .send({
      traces: [
        {
          name: `xt-trace-${tag}`,
          sessionId,
          spans: [{ spanId: 's1', name: 'root', startTime: now, endTime: now }],
        },
      ],
    })
    .expect(200);
  const traceId = ingest.body.traceIds[0] as string;
  const feedback = await a.agent
    .post(`/api/v1/traces/${traceId}/feedback`)
    .send({ rating: 1, comment: `only ${tag} may read this` })
    .expect(201);

  const view = await a.agent
    .post('/api/v1/trace-views')
    .send({ surface: 'traces', name: `xt-view-${tag}`, query: 'status=error' })
    .expect(201);
  const apiKey = await a.agent.post('/api/v1/api-keys').send({ name: `xt-apikey-${tag}` }).expect(201);
  const teamApiKey = await a.agent
    .post(`/api/v1/teams/${a.teamId}/api-keys`)
    .send({ name: `xt-teamkey-${tag}` })
    .expect(201);
  const invite = await a.agent
    .post(`/api/v1/teams/${a.teamId}/invites`)
    .send({ email: `xt-invitee-${tag}@example.com`, role: 'editor' })
    .expect(201);

  // A completion records a gateway_requests row, which is the only way to obtain
  // a `gateway/requests/:id` id.
  await a.agent
    .post('/api/v1/gateway/chat/completions')
    .set('Authorization', `Bearer ${virtualKey.body.key}`)
    .send({ model: modelName, messages: [{ role: 'user', content: 'hi' }] })
    .expect(200);
  const requests = await a.agent.get('/api/v1/gateway/requests').expect(200);
  const gatewayRequestId = requests.body.data[0]?.id as string;
  // Asserted, because an absent id makes the probe URL `/gateway/requests/undefined`,
  // which the controller answers 400 — and the suite would report a cross-tenant
  // leak on a route that is fine, with the real cause (this fixture) invisible.
  expect(gatewayRequestId).toBeTruthy();

  return {
    promptId: prompt.body.id,
    promptName,
    versionId: version.body.id,
    toolId: tool.body.id,
    secretId: secret.body.id,
    datasetId: dataset.body.id,
    exampleId: example.body.id,
    connectionId: connection.body.id,
    modelId: model.body.id,
    modelName,
    virtualKeyId: virtualKey.body.id,
    budgetId: budget.body.id,
    evalRuleId: evalRule.body.id,
    experimentId: experiment.body.id,
    runId: run.body.run_id,
    traceId,
    sessionId,
    feedbackId: feedback.body.id,
    viewId: view.body.id,
    apiKeyId: apiKey.body.id,
    teamApiKeyId: teamApiKey.body.id,
    inviteId: invite.body.id,
    gatewayRequestId,
    teamId: a.teamId,
    userId: a.userId,
  };
}

/** One probe: the request team B sends, carrying team A's id. */
interface Probe {
  /** Concrete URL, with A's ids substituted in. */
  url: string;
  /**
   * A body that PASSES validation. Several controllers validate the body before
   * the ownership lookup runs, so a probe sent with `{}` gets a 400 and never
   * reaches the check it is here to exercise — which reads as "safe" and is not.
   */
  body?: unknown;
}

/**
 * Every parameterised route, and the request that attacks it.
 *
 * Keyed by the exact `METHOD /path` the router walk produces. A missing key
 * fails the exhaustiveness test below, which is what carries this suite forward
 * to routes that do not exist yet.
 */
function probesFor(a: Fixture, b: Fixture): Record<string, Probe> {
  const ghostUuid = '00000000-0000-4000-8000-000000000000';
  const bind = { tool_alias: 'production' };
  return {
    'DELETE /api/v1/api-keys/:id': { url: `/api/v1/api-keys/${a.apiKeyId}` },

    'GET /api/v1/datasets/:id': { url: `/api/v1/datasets/${a.datasetId}` },
    'PATCH /api/v1/datasets/:id': { url: `/api/v1/datasets/${a.datasetId}`, body: { name: 'taken' } },
    'DELETE /api/v1/datasets/:id': { url: `/api/v1/datasets/${a.datasetId}` },
    'POST /api/v1/datasets/:id/examples': { url: `/api/v1/datasets/${a.datasetId}/examples`, body: { input: { name: 'x' } } },
    'POST /api/v1/datasets/:id/examples/from-feedback': {
      url: `/api/v1/datasets/${a.datasetId}/examples/from-feedback`,
      body: { feedback_ids: [a.feedbackId] },
    },
    'PATCH /api/v1/datasets/:id/examples/:exampleId': {
      url: `/api/v1/datasets/${a.datasetId}/examples/${a.exampleId}`,
      body: { input: { name: 'taken' } },
    },
    'DELETE /api/v1/datasets/:id/examples/:exampleId': {
      url: `/api/v1/datasets/${a.datasetId}/examples/${a.exampleId}`,
    },

    'GET /api/v1/eval-rules/:id': { url: `/api/v1/eval-rules/${a.evalRuleId}` },
    'GET /api/v1/eval-rules/:id/scores': { url: `/api/v1/eval-rules/${a.evalRuleId}/scores` },
    'PATCH /api/v1/eval-rules/:id': { url: `/api/v1/eval-rules/${a.evalRuleId}`, body: { name: 'taken' } },
    'DELETE /api/v1/eval-rules/:id': { url: `/api/v1/eval-rules/${a.evalRuleId}` },
    'POST /api/v1/eval-rules/:id/preview': { url: `/api/v1/eval-rules/${a.evalRuleId}/preview`, body: { limit: 1 } },
    'POST /api/v1/eval-rules/:id/to-dataset': {
      url: `/api/v1/eval-rules/${a.evalRuleId}/to-dataset`,
      body: { datasetName: 'taken', threshold: 50 },
    },

    'GET /api/v1/experiments/:id': { url: `/api/v1/experiments/${a.experimentId}` },
    'DELETE /api/v1/experiments/:id': { url: `/api/v1/experiments/${a.experimentId}` },
    'POST /api/v1/experiments/:id/runs': { url: `/api/v1/experiments/${a.experimentId}/runs`, body: {} },

    'PATCH /api/v1/gateway/budgets/:id': { url: `/api/v1/gateway/budgets/${a.budgetId}`, body: { limitUsd: 999 } },
    'DELETE /api/v1/gateway/budgets/:id': { url: `/api/v1/gateway/budgets/${a.budgetId}` },

    'GET /api/v1/gateway/connections/:id': { url: `/api/v1/gateway/connections/${a.connectionId}` },
    'PATCH /api/v1/gateway/connections/:id': { url: `/api/v1/gateway/connections/${a.connectionId}`, body: { label: 'taken' } },
    'DELETE /api/v1/gateway/connections/:id': { url: `/api/v1/gateway/connections/${a.connectionId}` },

    'PATCH /api/v1/gateway/keys/:id': { url: `/api/v1/gateway/keys/${a.virtualKeyId}`, body: { name: 'taken' } },
    'DELETE /api/v1/gateway/keys/:id': { url: `/api/v1/gateway/keys/${a.virtualKeyId}` },

    'GET /api/v1/gateway/models/:id': { url: `/api/v1/gateway/models/${a.modelId}` },
    'PATCH /api/v1/gateway/models/:id': { url: `/api/v1/gateway/models/${a.modelId}`, body: { publicName: 'taken' } },
    'DELETE /api/v1/gateway/models/:id': { url: `/api/v1/gateway/models/${a.modelId}` },
    'POST /api/v1/gateway/models/:id/test': { url: `/api/v1/gateway/models/${a.modelId}/test`, body: {} },

    'GET /api/v1/gateway/requests/:id': { url: `/api/v1/gateway/requests/${a.gatewayRequestId}` },

    'GET /api/v1/prompt-versions/:versionId': { url: `/api/v1/prompt-versions/${a.versionId}` },

    'GET /api/v1/prompts/:id': { url: `/api/v1/prompts/${a.promptId}` },
    'PATCH /api/v1/prompts/:id': { url: `/api/v1/prompts/${a.promptId}`, body: { name: 'taken' } },
    'DELETE /api/v1/prompts/:id': { url: `/api/v1/prompts/${a.promptId}` },
    'GET /api/v1/prompts/:id/aliases': { url: `/api/v1/prompts/${a.promptId}/aliases` },
    'GET /api/v1/prompts/:id/audit': { url: `/api/v1/prompts/${a.promptId}/audit` },
    'GET /api/v1/prompts/:id/tools': { url: `/api/v1/prompts/${a.promptId}/tools` },
    'GET /api/v1/prompts/:id/versions': { url: `/api/v1/prompts/${a.promptId}/versions` },
    'POST /api/v1/prompts/:id/versions': {
      url: `/api/v1/prompts/${a.promptId}/versions`,
      body: { messages: [{ role: 'user', content: 'taken' }] },
    },
    'GET /api/v1/prompts/:id/versions/:version_number': { url: `/api/v1/prompts/${a.promptId}/versions/1` },
    'GET /api/v1/prompts/:id/versions/:version_number/export': { url: `/api/v1/prompts/${a.promptId}/versions/1/export` },
    'GET /api/v1/prompts/:id/versions/:n/traces': { url: `/api/v1/prompts/${a.promptId}/versions/1/traces` },
    'GET /api/v1/prompts/:id/versions/diff': { url: `/api/v1/prompts/${a.promptId}/versions/diff?from=1&to=1` },
    'POST /api/v1/prompts/:id/aliases/:alias/promote': {
      url: `/api/v1/prompts/${a.promptId}/aliases/production/promote`,
      body: { version_number: 1 },
    },
    'DELETE /api/v1/prompts/:id/aliases/:alias': { url: `/api/v1/prompts/${a.promptId}/aliases/production` },
    'DELETE /api/v1/prompts/:id/aliases/:alias/tools': { url: `/api/v1/prompts/${a.promptId}/aliases/production/tools` },
    // Team B's OWN tool, so the only foreign id is the prompt.
    'PUT /api/v1/prompts/:id/aliases/:alias/tools/:toolId': {
      url: `/api/v1/prompts/${a.promptId}/aliases/production/tools/${b.toolId}`,
      body: bind,
    },
    'DELETE /api/v1/prompts/:id/aliases/:alias/tools/:toolId': {
      url: `/api/v1/prompts/${a.promptId}/aliases/production/tools/${b.toolId}`,
    },
    'PUT /api/v1/prompts/:id/tools/:toolId': { url: `/api/v1/prompts/${a.promptId}/tools/${b.toolId}`, body: bind },
    'DELETE /api/v1/prompts/:id/tools/:toolId': { url: `/api/v1/prompts/${a.promptId}/tools/${b.toolId}` },
    'POST /api/v1/prompts/:name/:alias/render': {
      url: `/api/v1/prompts/${a.promptName}/production/render`,
      body: { variables: { name: 'x' } },
    },
    'POST /api/v1/prompts/:promptId/optimize': {
      url: `/api/v1/prompts/${a.promptId}/optimize`,
      body: { dataset_id: b.datasetId, models: [b.modelName] },
    },

    'GET /api/v1/runs/:id': { url: `/api/v1/runs/${a.runId}` },
    'DELETE /api/v1/runs/:id': { url: `/api/v1/runs/${a.runId}` },
    'GET /api/v1/runs/:id/report': { url: `/api/v1/runs/${a.runId}/report` },
    'GET /api/v1/runs/:id/cells/:cellKey': { url: `/api/v1/runs/${a.runId}/cells/any-cell` },
    'GET /api/v1/runs/:id/candidates/:candidateId': { url: `/api/v1/runs/${a.runId}/candidates/${ghostUuid}` },
    'POST /api/v1/runs/:id/promote': {
      url: `/api/v1/runs/${a.runId}/promote`,
      body: { prompt_candidate_id: ghostUuid, alias: 'production' },
    },

    'PUT /api/v1/secrets/:id': { url: `/api/v1/secrets/${a.secretId}`, body: { value: 'taken' } },
    'DELETE /api/v1/secrets/:id': { url: `/api/v1/secrets/${a.secretId}` },

    'GET /api/v1/sessions/:id': { url: `/api/v1/sessions/${a.sessionId}` },

    'GET /api/v1/tools/:id': { url: `/api/v1/tools/${a.toolId}` },
    'PATCH /api/v1/tools/:id': { url: `/api/v1/tools/${a.toolId}`, body: { name: 'taken' } },
    'DELETE /api/v1/tools/:id': { url: `/api/v1/tools/${a.toolId}` },
    'GET /api/v1/tools/:id/aliases': { url: `/api/v1/tools/${a.toolId}/aliases` },
    'GET /api/v1/tools/:id/audit': { url: `/api/v1/tools/${a.toolId}/audit` },
    'GET /api/v1/tools/:id/versions': { url: `/api/v1/tools/${a.toolId}/versions` },
    'GET /api/v1/tools/:id/versions/:version_number': { url: `/api/v1/tools/${a.toolId}/versions/1` },
    'POST /api/v1/tools/:id/versions': {
      url: `/api/v1/tools/${a.toolId}/versions`,
      body: { parametersSchema: { type: 'object' }, executor: { type: 'client' } },
    },
    'POST /api/v1/tools/:id/aliases/:alias/promote': {
      url: `/api/v1/tools/${a.toolId}/aliases/production/promote`,
      body: { version_number: 1 },
    },
    'POST /api/v1/tools/:id/execute': { url: `/api/v1/tools/${a.toolId}/execute`, body: { arguments: {} } },

    'PATCH /api/v1/trace-views/:id': { url: `/api/v1/trace-views/${a.viewId}`, body: { name: 'taken' } },
    'DELETE /api/v1/trace-views/:id': { url: `/api/v1/trace-views/${a.viewId}` },

    'GET /api/v1/traces/:id': { url: `/api/v1/traces/${a.traceId}` },
    'GET /api/v1/traces/:id/feedback': { url: `/api/v1/traces/${a.traceId}/feedback` },
    'POST /api/v1/traces/:id/feedback': { url: `/api/v1/traces/${a.traceId}/feedback`, body: { rating: -1 } },
    'PATCH /api/v1/traces/:id/feedback/:feedbackId': {
      url: `/api/v1/traces/${a.traceId}/feedback/${a.feedbackId}`,
      body: { rating: -1 },
    },
  };
}

/**
 * The `/teams/:id/*` family, where `:id` is the team itself rather than an object
 * inside one. These answer 403, not 404, and deliberately: `requireTeamRole` asks
 * only "does the caller hold a role in this team", so a team that does not exist
 * and a team the caller is simply not in produce the same rejection. That is the
 * property worth having — it is asserted directly below rather than assumed, so
 * a later "helpfully" distinguishing the two turns this suite red.
 */
const TEAM_SCOPED = new Set([
  'GET /api/v1/teams/:id/api-keys',
  'POST /api/v1/teams/:id/api-keys',
  'DELETE /api/v1/teams/:id/api-keys/:keyId',
  'GET /api/v1/teams/:id/audit',
  'GET /api/v1/teams/:id/audit/actors',
  'GET /api/v1/teams/:id/invites',
  'POST /api/v1/teams/:id/invites',
  'DELETE /api/v1/teams/:id/invites/:inviteId',
  'GET /api/v1/teams/:id/members',
  'DELETE /api/v1/teams/:id/members/:userId',
  'PATCH /api/v1/teams/:id/members/:userId/roles',
]);

/**
 * Parameterised routes that are not object lookups at all, each with the reason.
 * Adding to this list is a decision; leaving a route out of it is not.
 */
const NOT_AN_OBJECT_LOOKUP = new Map<string, string>([
  [
    'POST /api/v1/teams/invites/:token/accept',
    'the token IS the credential — it is unguessable by design, and covered by invites.test.ts',
  ],
]);


/**
 * Sends one probe through an authenticated agent.
 *
 * Indexed rather than called by name because the method varies per route; the
 * agent must stay the receiver, since supertest's agent reads `this.app`.
 *
 * @param agent - The attacking team's agent.
 * @param method - Lowercase HTTP method.
 * @param url - Full path including query string.
 * @param body - Request body; ignored by GET/DELETE.
 * @returns The response status and parsed body.
 */
async function probe(
  agent: AuthedAgent,
  method: string,
  url: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const a = agent.agent as unknown as Record<
    string,
    (u: string) => { send: (b: unknown) => Promise<{ status: number; body: unknown }> }
  >;
  return a[method]!.call(agent.agent, url).send(body ?? {});
}

describe('cross-tenant object access', () => {
  let A: Fixture;
  let B: Fixture;
  let bAgent: AuthedAgent;
  let upstream: http.Server;

  beforeAll(async () => {
    // A stand-in for a model provider, so the two completions below are a local
    // round trip rather than a call to api.openai.com.
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-xt',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'gpt-4o-mini',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    const upstreamUrl = await new Promise<string>((resolve) => {
      upstream.listen(0, () => resolve(`http://localhost:${(upstream.address() as AddressInfo).port}/v1`));
    });
    allowLoopbackForTests();

    const teamA = await authedAgent(app);
    bAgent = await authedAgent(app);
    A = await buildFixture(teamA, 'a', upstreamUrl);
    B = await buildFixture(bAgent, 'b', upstreamUrl);
  });

  afterAll(async () => {
    resetSsrfAllowlist();
    await new Promise<void>((done) => {
      upstream.closeAllConnections();
      upstream.close(() => done());
    });
  });

  it('covers every parameterised route that is mounted', () => {
    const routes = mountedRoutes(app);
    // A silent empty walk, or one that lost the nested team routes, would pass
    // every assertion below by having nothing to assert.
    expect(routes.length).toBeGreaterThan(80);
    expect(routes.map(routeKey)).toContain('PATCH /api/v1/teams/:id/members/:userId/roles');

    const parameterised = routes
      .map(routeKey)
      // Better Auth mounts its own surface under a catch-all we do not own.
      .filter((k) => k.includes('/:') && !k.includes('/api/v1/auth/'));

    const known = new Set([
      ...Object.keys(probesFor(A, B)),
      ...TEAM_SCOPED,
      ...NOT_AN_OBJECT_LOOKUP.keys(),
    ]);
    const uncovered = [...new Set(parameterised)].filter((k) => !known.has(k)).sort();

    // A new route with a resource id in its path lands here the day it is
    // mounted. Give it a probe above, or an entry in one of the two lists with
    // the reason it needs none.
    expect(uncovered).toEqual([]);

    // Each exemption carries a reason, and a reason that says nothing is how the
    // list above turns into a way to silence this test rather than answer it.
    const unexplained = [...NOT_AN_OBJECT_LOOKUP].filter(([, why]) => why.trim().length < 20);
    expect(unexplained).toEqual([]);
  });

  it('answers every resource route for another team as if the id did not exist', async () => {
    const probes = probesFor(A, B);
    const leaks: string[] = [];

    for (const [key, attack] of Object.entries(probes)) {
      const method = key.slice(0, key.indexOf(' ')).toLowerCase();
      const res = await probe(bAgent, method, attack.url, attack.body);
      if (res.status !== 404) {
        leaks.push(`${key} -> ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
      }
    }

    expect(leaks).toEqual([]);
  });

  it('rejects a team the caller is not in exactly as it rejects one that does not exist', async () => {
    // The 403 these routes answer with must carry no information. If a real
    // foreign team and a random UUID ever diverge, holding any team id becomes a
    // way to learn whether that team exists.
    const ghostTeam = randomUUID();
    const seen = new Map<string, Array<{ status: number; body: string }>>();

    for (const key of TEAM_SCOPED) {
      const method = key.slice(0, key.indexOf(' ')).toLowerCase();
      const tail = key.slice(key.indexOf(' ') + 1).replace('/api/v1/teams/:id', '');
      const results = [];
      for (const teamId of [A.teamId, ghostTeam]) {
        const path =
          '/api/v1/teams/' +
          teamId +
          tail
            .replace(':keyId', A.teamApiKeyId)
            .replace(':inviteId', A.inviteId)
            .replace(':userId', A.userId);
        const res = await probe(bAgent, method, path, { name: 'taken', role: 'editor' });
        results.push({ status: res.status, body: JSON.stringify(res.body) });
      }
      seen.set(key, results);
    }

    const divergent = [...seen.entries()]
      .filter(([, [real, ghost]]) => real.status !== ghost.status || real.body !== ghost.body)
      .map(([key, [real, ghost]]) => `${key}: foreign ${real.status} ${real.body} vs unknown ${ghost.status} ${ghost.body}`);

    expect(divergent).toEqual([]);
    // And the rejection is a rejection, not an accidental success.
    for (const [key, [real]] of seen) {
      expect(`${key} ${real.status}`).toBe(`${key} 403`);
    }
  });

  it('refuses to bind a budget to another team’s virtual key', async () => {
    // First of three places the "verify ownership in the caller" convention was
    // not followed. Unlike every probe above, the foreign id arrives in the BODY, so
    // no URL-level ownership check ever sees it: the row is written against the
    // caller's own team and points at a key the caller cannot see. The budget
    // alert that later fires reads that key's name with no team filter of its own
    // (`BudgetsRepository.findVirtualKeyName`), so the other team's key name is
    // what the alert would print.
    const foreign = await bAgent.agent
      .post('/api/v1/gateway/budgets/')
      .send({ period: 'month', limitUsd: 1, virtualKeyId: A.virtualKeyId });
    expect(foreign.status).toBe(404);

    // And an id that belongs to nobody is the same answer, not a raw foreign-key
    // violation surfacing as a 500.
    const ghost = await bAgent.agent
      .post('/api/v1/gateway/budgets/')
      .send({ period: 'week', limitUsd: 1, virtualKeyId: randomUUID() });
    expect(ghost.status).toBe(404);
  });
  it('refuses a trace span that points at another team’s prompt version', async () => {
    // Second of the body-borne references. `POST /api/v1/traces` takes a
    // `promptVersionId` per span and stored it as given, while the gateway's own
    // path for the same field (`resolveClientPromptVersionId`) has always
    // refused a version from outside the team. The same request body two lines
    // up is already checked — a `traceId` belonging to another team is a 404 —
    // so this is the one field in the batch that was taken on trust.
    const now = Date.now();
    const foreign = await bAgent.agent.post('/api/v1/traces').send({
      traces: [
        {
          name: 'xt-foreign-version',
          spans: [
            {
              spanId: `xt-foreign-${now}`,
              name: 'llm',
              kind: 'llm',
              status: 'ok',
              startTime: new Date(now - 1000).toISOString(),
              endTime: new Date(now).toISOString(),
              promptVersionId: A.versionId,
            },
          ],
        },
      ],
    });
    expect(foreign.status).toBe(404);

    // Same answer for an id that belongs to nobody: the refusal must not be the
    // way to tell a real version id from an invented one.
    const ghost = await bAgent.agent.post('/api/v1/traces').send({
      traces: [
        {
          name: 'xt-ghost-version',
          spans: [
            {
              spanId: `xt-ghost-${now}`,
              name: 'llm',
              kind: 'llm',
              status: 'ok',
              startTime: new Date(now - 1000).toISOString(),
              endTime: new Date(now).toISOString(),
              promptVersionId: randomUUID(),
            },
          ],
        },
      ],
    });
    expect(ghost.status).toBe(404);
  });

  it('never names another team’s prompt in a grouped read, whatever a span points at', async () => {
    // The fence above stops new rows. This one covers the rows a database may
    // already hold: both grouped reads resolve `spans.prompt_version_id` to a
    // prompt NAME through a join that had no team filter of its own, so a span
    // row carrying a foreign id — however it got there — printed the other
    // team's prompt name and id straight into team B's own dashboard.
    //
    // Arranged with one UPDATE rather than through the API, because the API no
    // longer allows this state to be created. That is the point of the test.
    const now = Date.now();
    const ingest = await bAgent.agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            name: 'xt-legacy-row',
            spans: [
              {
                spanId: `xt-legacy-${now}`,
                name: 'llm',
                kind: 'llm',
                status: 'ok',
                startTime: new Date(now - 1000).toISOString(),
                endTime: new Date(now).toISOString(),
              },
            ],
          },
        ],
      })
      .expect(200);
    const traceId = ingest.body.traceIds[0] as string;
    await prisma.span.updateMany({ where: { traceId }, data: { promptVersionId: A.versionId } });
    await bAgent.agent.post(`/api/v1/traces/${traceId}/feedback`).send({ rating: 1 }).expect(201);

    const analytics = await bAgent.agent
      .get('/api/v1/traces/analytics?group_by=prompt_version')
      .expect(200);
    const summary = await bAgent.agent
      .get('/api/v1/traces/feedback/summary?group_by=prompt_version')
      .expect(200);

    // The bucket itself may stand — it counts team B's own span. What it must not
    // carry is anything read out of team A's row.
    for (const [what, body] of [
      ['analytics', analytics.body],
      ['feedback summary', summary.body],
    ] as const) {
      const json = JSON.stringify(body);
      expect(`${what}: ${json.includes(A.promptName)}`).toBe(`${what}: false`);
      expect(`${what}: ${json.includes(A.promptId)}`).toBe(`${what}: false`);
    }
  });
  it('refuses an experiment built on another team’s prompt or versions', async () => {
    // Third of the body-borne references, and the one the matrix is furthest from
    // reaching: `POST /api/v1/experiments` carries no path parameter at all, so it
    // never enters the route walk above. Only `dataset_id` was checked; `prompt_id`
    // and every entry of `version_ids` were written to the row as given.
    const base = { dataset_id: B.datasetId, models: ['gpt-4o-mini'] };

    const foreignPrompt = await bAgent.agent
      .post('/api/v1/experiments/')
      .send({ ...base, prompt_id: A.promptId, version_ids: [A.versionId] });
    expect(foreignPrompt.status).toBe(404);

    // An id nobody owns is the same answer, not a raw foreign-key violation
    // surfacing as a 500.
    const ghostPrompt = await bAgent.agent
      .post('/api/v1/experiments/')
      .send({ ...base, prompt_id: randomUUID(), version_ids: [B.versionId] });
    expect(ghostPrompt.status).toBe(404);

    // And the versions are checked one by one: a legitimate prompt of the caller's
    // own does not launder a foreign version id in the same array.
    const foreignVersion = await bAgent.agent
      .post('/api/v1/experiments/')
      .send({ ...base, prompt_id: B.promptId, version_ids: [B.versionId, A.versionId] });
    expect(foreignVersion.status).toBe(404);
  });
});
