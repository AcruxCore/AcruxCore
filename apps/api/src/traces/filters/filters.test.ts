import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

type Agent = ReturnType<typeof request.agent>;

async function truncateTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    span_payloads, spans, trace_feedback, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys, provider_connections,
    gateway_model_fallbacks, gateway_models,
    audit_log, prompt_aliases, prompt_versions, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
}

let seq = 0;
function nextEmail(): string {
  return `filters-${++seq}-${Date.now()}@example.com`;
}

/** Creates a prompt with one committed version; returns both ids. */
async function createPrompt(
  agent: Agent,
  name: string,
): Promise<{ promptId: string; versionId: string }> {
  const prompt = await agent.post('/api/v1/prompts').send({ name }).expect(201);
  const version = await agent
    .post(`/api/v1/prompts/${prompt.body.id}/versions`)
    .send({ messages: [{ role: 'system', content: 'Hello {{ name }}' }] })
    .expect(201);
  return { promptId: prompt.body.id, versionId: version.body.id };
}

/** Commits another version of an existing prompt and returns its id. */
async function addVersion(agent: Agent, promptId: string, content: string): Promise<string> {
  const version = await agent
    .post(`/api/v1/prompts/${promptId}/versions`)
    .send({ messages: [{ role: 'system', content }] })
    .expect(201);
  return version.body.id;
}

interface TraceOpts {
  name?: string;
  sessionId?: string;
  promptVersionId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  variables?: unknown;
  capturePayloads?: boolean;
  model?: string;
}

/** Ingests one trace holding a single llm span, with whatever the test needs on it. */
async function postTrace(agent: Agent, opts: TraceOpts = {}): Promise<string> {
  const res = await agent
    .post('/api/v1/traces')
    .send({
      traces: [
        {
          name: opts.name ?? 'agent-run',
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
          ...(opts.tags ? { tags: opts.tags } : {}),
          ...(opts.metadata ? { metadata: opts.metadata } : {}),
          ...(opts.capturePayloads !== undefined ? { capturePayloads: opts.capturePayloads } : {}),
          spans: [
            {
              spanId: 's1',
              name: 'chat',
              kind: 'llm',
              status: 'ok',
              startTime: new Date('2026-09-01T10:00:00Z').toISOString(),
              endTime: new Date('2026-09-01T10:00:01Z').toISOString(),
              model: opts.model ?? 'gpt-4o-mini',
              ...(opts.promptVersionId ? { promptVersionId: opts.promptVersionId } : {}),
              ...(opts.input !== undefined ? { input: opts.input } : {}),
              ...(opts.output !== undefined ? { output: opts.output } : {}),
              ...(opts.variables !== undefined ? { variables: opts.variables } : {}),
            },
          ],
        },
      ],
    })
    .expect(200);
  return res.body.traceIds[0];
}

/** Trace ids returned by GET /traces for a raw query string. */
async function listTraceIds(agent: Agent, query: string): Promise<string[]> {
  const res = await agent.get(`/api/v1/traces?${query}`).expect(200);
  return res.body.data.map((t: { id: string }) => t.id);
}

/** Feedback ids returned by GET /traces/feedback for a raw query string. */
async function listFeedbackIds(agent: Agent, query: string): Promise<string[]> {
  const res = await agent.get(`/api/v1/traces/feedback?${query}`).expect(200);
  return res.body.data.map((f: { id: string }) => f.id);
}

/** Attaches feedback to a trace and returns its id. */
async function postFeedback(
  agent: Agent,
  traceId: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await agent.post(`/api/v1/traces/${traceId}/feedback`).send(body).expect(201);
  return res.body.id;
}

beforeEach(async () => {
  await truncateTables();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('shared trace filters — trace list', () => {
  it('prompt_id matches every version of one prompt and excludes another prompt', async () => {
    const { agent } = await authedAgent(app);
    const checkout = await createPrompt(agent, 'checkout');
    const checkoutV2 = await addVersion(agent, checkout.promptId, 'Hi {{ name }}!');
    const support = await createPrompt(agent, 'support');

    const onV1 = await postTrace(agent, { promptVersionId: checkout.versionId });
    const onV2 = await postTrace(agent, { promptVersionId: checkoutV2 });
    const elsewhere = await postTrace(agent, { promptVersionId: support.versionId });

    const byPrompt = await listTraceIds(agent, `prompt_id=${checkout.promptId}`);
    expect(byPrompt.sort()).toEqual([onV1, onV2].sort());
    expect(byPrompt).not.toContain(elsewhere);

    // The version filter still narrows to the one version, unchanged.
    const byVersion = await listTraceIds(agent, `prompt_version_id=${checkoutV2}`);
    expect(byVersion).toEqual([onV2]);
  });

  it('prompt_id is team-scoped', async () => {
    const owner = await authedAgent(app);
    const { promptId, versionId } = await createPrompt(owner.agent, 'checkout');
    await postTrace(owner.agent, { promptVersionId: versionId });

    const stranger = await authedAgent(app, { email: nextEmail() });
    expect(await listTraceIds(stranger.agent, `prompt_id=${promptId}`)).toEqual([]);
  });

  it('q finds a word that appears only in a captured payload', async () => {
    const { agent } = await authedAgent(app);
    const london = await postTrace(agent, {
      name: 'trip-planner',
      input: 'I want to visit London next spring',
      output: 'Here are three hotels in Camden.',
    });
    await postTrace(agent, { name: 'trip-planner', input: 'I want to visit Lisbon' });

    // The reported gap: the operator remembers the question, not the trace name.
    expect(await listTraceIds(agent, 'q=London')).toEqual([london]);
    expect(await listTraceIds(agent, 'q=Camden')).toEqual([london]);
    expect(await listTraceIds(agent, 'q=Reykjavik')).toEqual([]);
  });

  it('q_in narrows the search to one side of the exchange', async () => {
    const { agent } = await authedAgent(app);
    const traceId = await postTrace(agent, {
      name: 'trip-planner',
      input: 'I want to visit London',
      output: 'Here are three hotels in Camden.',
    });

    expect(await listTraceIds(agent, 'q=London&q_in=input')).toEqual([traceId]);
    expect(await listTraceIds(agent, 'q=London&q_in=output')).toEqual([]);
    expect(await listTraceIds(agent, 'q=Camden&q_in=output')).toEqual([traceId]);
    expect(await listTraceIds(agent, 'q=Camden&q_in=input')).toEqual([]);

    // `name` is the old behaviour: trace and span names only, no payload text.
    expect(await listTraceIds(agent, 'q=London&q_in=name')).toEqual([]);
    expect(await listTraceIds(agent, 'q=trip-planner&q_in=name')).toEqual([traceId]);
  });

  it('a trace whose payloads were not captured is not findable by its content', async () => {
    const { agent } = await authedAgent(app);
    const captured = await postTrace(agent, { input: 'I want to visit London' });
    await postTrace(agent, { capturePayloads: false, input: 'I want to visit London' });

    expect(await listTraceIds(agent, 'q=London')).toEqual([captured]);
  });

  it('content search is team-scoped', async () => {
    const owner = await authedAgent(app);
    await postTrace(owner.agent, { input: 'I want to visit London' });

    const stranger = await authedAgent(app, { email: nextEmail() });
    expect(await listTraceIds(stranger.agent, 'q=London')).toEqual([]);
  });

  it('filters combine, and one near-miss is enough to exclude a trace', async () => {
    const { agent } = await authedAgent(app);
    const { promptId, versionId } = await createPrompt(agent, 'checkout');

    const match = await postTrace(agent, {
      promptVersionId: versionId,
      tags: ['prod', 'eu'],
      metadata: { env: 'prod' },
      input: 'I want to visit London',
    });
    // Same everything, but staging.
    await postTrace(agent, {
      promptVersionId: versionId,
      tags: ['staging', 'eu'],
      metadata: { env: 'staging' },
      input: 'I want to visit London',
    });

    const q = `prompt_id=${promptId}&tags=prod&tags=eu&metadata[env]=prod&q=London`;
    expect(await listTraceIds(agent, q)).toEqual([match]);
    expect(await listTraceIds(agent, `${q}&tags=canary`)).toEqual([]);
  });
});

describe('shared trace filters — feedback feed', () => {
  it('the trace filters apply to a feedback row through its trace', async () => {
    const { agent } = await authedAgent(app);
    const { promptId, versionId } = await createPrompt(agent, 'checkout');
    const other = await createPrompt(agent, 'support');

    const onCheckout = await postTrace(agent, {
      promptVersionId: versionId,
      tags: ['prod'],
      metadata: { env: 'prod' },
      input: 'I want to visit London',
    });
    const onSupport = await postTrace(agent, { promptVersionId: other.versionId });

    const wanted = await postFeedback(agent, onCheckout, { rating: -1, comment: 'wrong city' });
    const unwanted = await postFeedback(agent, onSupport, { rating: -1, comment: 'unrelated' });

    expect(await listFeedbackIds(agent, `prompt_id=${promptId}`)).toEqual([wanted]);
    expect(await listFeedbackIds(agent, 'tags=prod')).toEqual([wanted]);
    expect(await listFeedbackIds(agent, 'metadata[env]=prod')).toEqual([wanted]);
    expect(await listFeedbackIds(agent, 'q=London')).toEqual([wanted]);

    const all = await listFeedbackIds(agent, 'limit=100');
    expect(all.sort()).toEqual([wanted, unwanted].sort());
  });

  it('rating, source, label and has_comment narrow the feed', async () => {
    const { agent } = await authedAgent(app);
    const traceId = await postTrace(agent);

    const up = await postFeedback(agent, traceId, { rating: 1, comment: 'good' });
    const down = await postFeedback(agent, traceId, {
      rating: -1,
      label: 'hallucination',
      source: 'developer',
    });
    const labelOnly = await postFeedback(agent, traceId, { label: 'needs-review' });

    expect(await listFeedbackIds(agent, 'rating=up')).toEqual([up]);
    expect(await listFeedbackIds(agent, 'rating=down')).toEqual([down]);
    expect(await listFeedbackIds(agent, 'rating=none')).toEqual([labelOnly]);
    expect(await listFeedbackIds(agent, 'source=developer')).toEqual([down]);
    expect(await listFeedbackIds(agent, 'label=hallucination')).toEqual([down]);
    expect(await listFeedbackIds(agent, 'has_comment=true')).toEqual([up]);

    // `has_comment=false` must not read as truthy just because it is a string.
    expect((await listFeedbackIds(agent, 'has_comment=false')).sort()).toEqual(
      [down, labelOnly].sort(),
    );
  });

  it('paginates and counts the filtered set, not the whole feed', async () => {
    const { agent } = await authedAgent(app);
    const traceId = await postTrace(agent);
    await postFeedback(agent, traceId, { rating: 1 });
    await postFeedback(agent, traceId, { rating: -1, comment: 'a' });
    await postFeedback(agent, traceId, { rating: -1, comment: 'b' });

    const res = await agent.get('/api/v1/traces/feedback?rating=down&limit=1').expect(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data).toHaveLength(1);

    const second = await agent
      .get('/api/v1/traces/feedback?rating=down&limit=1&page=2')
      .expect(200);
    expect(second.body.total).toBe(2);
    expect(second.body.data[0].id).not.toBe(res.body.data[0].id);
  });

  it('the feedback feed stays team-scoped under filters', async () => {
    const owner = await authedAgent(app);
    const traceId = await postTrace(owner.agent, { tags: ['prod'] });
    await postFeedback(owner.agent, traceId, { rating: -1, comment: 'x' });

    const stranger = await authedAgent(app, { email: nextEmail() });
    expect(await listFeedbackIds(stranger.agent, 'rating=down')).toEqual([]);
    expect(await listFeedbackIds(stranger.agent, 'tags=prod')).toEqual([]);
  });
});
