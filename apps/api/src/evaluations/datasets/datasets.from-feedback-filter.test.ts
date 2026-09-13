import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

type Agent = ReturnType<typeof request.agent>;

async function truncateTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    dataset_examples, datasets,
    span_payloads, spans, trace_feedback, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys,
    gateway_model_fallbacks, gateway_models, provider_connections,
    prompt_aliases, prompt_versions, prompts,
    audit_log, api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
}

let seq = 0;
function nextEmail(): string {
  return `ds-filter-${++seq}-${Date.now()}@example.com`;
}

/** Creates a prompt with one committed version; returns both ids. */
async function createPrompt(
  agent: Agent,
  name: string,
): Promise<{ promptId: string; versionId: string }> {
  const prompt = await agent.post('/api/v1/prompts').send({ name }).expect(201);
  const version = await agent
    .post(`/api/v1/prompts/${prompt.body.id}/versions`)
    .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] })
    .expect(201);
  return { promptId: prompt.body.id, versionId: version.body.id };
}

/**
 * Ingests one trace with a single llm span. Omitting `promptVersionId` and
 * `variables` reproduces an agent whose prompt lives in its own code — the case
 * that used to be blamed on payload capture.
 */
async function postTrace(
  agent: Agent,
  opts: {
    promptVersionId?: string;
    variables?: Record<string, unknown>;
    tags?: string[];
    input?: unknown;
    attributes?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const res = await agent
    .post('/api/v1/traces')
    .send({
      traces: [
        {
          name: 'agent-run',
          ...(opts.tags ? { tags: opts.tags } : {}),
          spans: [
            {
              spanId: 's1',
              name: 'chat',
              kind: 'llm',
              status: 'ok',
              startTime: new Date('2026-09-01T10:00:00Z').toISOString(),
              endTime: new Date('2026-09-01T10:00:01Z').toISOString(),
              model: 'gpt-4o-mini',
              ...(opts.promptVersionId ? { promptVersionId: opts.promptVersionId } : {}),
              ...(opts.variables ? { variables: opts.variables } : {}),
              ...(opts.attributes ? { attributes: opts.attributes } : {}),
              input: opts.input ?? 'hello',
              output: 'hi there',
            },
          ],
        },
      ],
    })
    .expect(200);
  return res.body.traceIds[0];
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
  await truncateTables();
  await prisma.$disconnect();
});

describe('POST /api/v1/datasets/from-feedback — filter mode', () => {
  it('builds from criteria instead of a hand-collected id list', async () => {
    const { agent } = await authedAgent(app);
    const checkout = await createPrompt(agent, 'checkout');
    const support = await createPrompt(agent, 'support');

    const wanted = await postTrace(agent, {
      promptVersionId: checkout.versionId,
      variables: { name: 'Al' },
    });
    const otherPrompt = await postTrace(agent, {
      promptVersionId: support.versionId,
      variables: { name: 'Bo' },
    });

    await postFeedback(agent, wanted, { rating: -1, comment: 'greeted the wrong person' });
    await postFeedback(agent, otherPrompt, { rating: -1, comment: 'unrelated' });
    // A thumbs-up on the same prompt: matches prompt_id, not rating=down.
    await postFeedback(agent, wanted, { rating: 1, comment: 'good' });

    const res = await agent
      .post('/api/v1/datasets/from-feedback')
      .send({
        name: 'checkout-regressions',
        filter: { prompt_id: checkout.promptId, rating: 'down', has_comment: true },
      })
      .expect(201);

    expect(res.body.example_count).toBe(1);
    expect(res.body.matched).toBe(1);

    const dataset = await agent.get(`/api/v1/datasets/${res.body.id}`).expect(200);
    expect(dataset.body.examples).toHaveLength(1);
    expect(dataset.body.examples[0].input).toEqual({ name: 'Al' });
    expect(dataset.body.examples[0].criteria).toBe('greeted the wrong person');
  });

  /**
   * Issue #460 — the "add all matching" dialog sends its chips as a JSON body, where a
   * boolean is a real boolean rather than the string a query string carries. The failure
   * chips the bar offers on this surface have to survive that trip, both in the schema
   * and in the SQL, or a dataset quietly gets rows the person filtered out.
   */
  it('narrows by the failure filters the dialog offers, sent as JSON types', async () => {
    const { agent } = await authedAgent(app);
    const { promptId, versionId } = await createPrompt(agent, 'weather');

    const declared = await postTrace(agent, {
      promptVersionId: versionId,
      variables: { name: 'Al' },
      attributes: { errorType: 'tool_declared', errorCode: 'location_not_found' },
    });
    const otherCode = await postTrace(agent, {
      promptVersionId: versionId,
      variables: { name: 'Bo' },
      attributes: { errorType: 'tool_declared', errorCode: 'ambiguous_city' },
    });
    await postFeedback(agent, declared, { rating: -1, comment: 'invented a forecast' });
    await postFeedback(agent, otherCode, { rating: -1, comment: 'picked the wrong city' });

    const res = await agent
      .post('/api/v1/datasets/from-feedback')
      .send({
        name: 'atlantis-failures',
        filter: {
          prompt_id: promptId,
          error_type: 'tool_declared',
          error_code: 'location_not_found',
          has_warning: false,
        },
      })
      .expect(201);

    expect(res.body.matched).toBe(1);
    const dataset = await agent.get(`/api/v1/datasets/${res.body.id}`).expect(200);
    expect(dataset.body.examples).toHaveLength(1);
    expect(dataset.body.examples[0].criteria).toBe('invented a forecast');
  });

  it('a filter cannot reach another team\'s feedback', async () => {
    const owner = await authedAgent(app);
    const { versionId } = await createPrompt(owner.agent, 'checkout');
    const traceId = await postTrace(owner.agent, {
      promptVersionId: versionId,
      variables: { name: 'Al' },
    });
    await postFeedback(owner.agent, traceId, { rating: -1, comment: 'bad' });

    const stranger = await authedAgent(app, { email: nextEmail() });
    const res = await stranger.agent
      .post('/api/v1/datasets/from-feedback')
      .send({ name: 'poach', filter: { rating: 'down' } })
      .expect(422);

    expect(res.body.error.message).toContain('No feedback rows matched');
  });

  it('rejects a body carrying both selectors, and one carrying neither', async () => {
    const { agent } = await authedAgent(app);

    const both = await agent
      .post('/api/v1/datasets/from-feedback')
      .send({
        name: 'x',
        feedback_ids: ['00000000-0000-0000-0000-000000000000'],
        filter: { rating: 'down' },
      })
      .expect(400);
    expect(both.body.error.message).toContain('exactly one of feedback_ids or filter');

    await agent.post('/api/v1/datasets/from-feedback').send({ name: 'x' }).expect(400);
  });
});

describe('from-feedback — the 422 names the real cause', () => {
  it('says the run used no stored prompt, not "enable payload capture"', async () => {
    const { agent } = await authedAgent(app);
    // The reported case: a LangChain agent whose system prompt lives in code.
    // Payload capture is on, and irrelevant.
    const traceId = await postTrace(agent, { input: 'I want to visit London' });
    await postFeedback(agent, traceId, { rating: -1, comment: 'wrong city' });

    const res = await agent
      .post('/api/v1/datasets/from-feedback')
      .send({ name: 'from-langchain', filter: { rating: 'down' } })
      .expect(422);

    expect(res.body.error.message).toContain('the prompt is not stored in AcruxCore');
    // The reason a person reads must not send them to a setting that was
    // already correct.
    expect(res.body.error.message).not.toContain('payload capture');
  });

  it('counts each distinct reason when the rows failed for different ones', async () => {
    const { agent } = await authedAgent(app);
    const { versionId } = await createPrompt(agent, 'checkout');

    const noPrompt = await postTrace(agent);
    // Used a stored prompt, but the call captured no variables to replay.
    const noVariables = await postTrace(agent, { promptVersionId: versionId });

    await postFeedback(agent, noPrompt, { rating: -1, comment: 'a' });
    await postFeedback(agent, noVariables, { rating: -1, comment: 'b' });

    const res = await agent
      .post('/api/v1/datasets/from-feedback')
      .send({ name: 'mixed', filter: { rating: 'down' } })
      .expect(422);

    expect(res.body.error.message).toContain('1 because');
    expect(res.body.error.message).toContain('the prompt is not stored in AcruxCore');
    expect(res.body.error.message).toContain('no prompt variables were captured');
  });
});

describe('POST /api/v1/datasets/:id/examples/from-feedback — filter mode', () => {
  it('appends every row the criteria select, and skips ones already present', async () => {
    const { agent } = await authedAgent(app);
    const { promptId, versionId } = await createPrompt(agent, 'checkout');

    const first = await postTrace(agent, {
      promptVersionId: versionId,
      variables: { name: 'Al' },
      tags: ['prod'],
    });
    await postFeedback(agent, first, { rating: -1, comment: 'first' });

    const created = await agent
      .post('/api/v1/datasets/from-feedback')
      .send({ name: 'growing', filter: { prompt_id: promptId, rating: 'down' } })
      .expect(201);
    const datasetId = created.body.id;

    // New traffic arrives, and the same criteria pick it up.
    const second = await postTrace(agent, {
      promptVersionId: versionId,
      variables: { name: 'Bo' },
      tags: ['prod'],
    });
    await postFeedback(agent, second, { rating: -1, comment: 'second' });

    const res = await agent
      .post(`/api/v1/datasets/${datasetId}/examples/from-feedback`)
      .send({ filter: { prompt_id: promptId, rating: 'down', tags: ['prod'] } })
      .expect(201);

    expect(res.body.added).toBe(1);
    expect(res.body.example_count).toBe(2);
    expect(res.body.matched).toBe(2);
    expect(res.body.skipped).toEqual([
      expect.objectContaining({ reason: 'already in this dataset' }),
    ]);
  });
});
