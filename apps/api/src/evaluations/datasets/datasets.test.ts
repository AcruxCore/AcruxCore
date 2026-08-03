import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

const CANNED_OPENAI = {
  id: 'chatcmpl-int',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
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

beforeEach(async () => {
  await truncateTables();
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
});

describe('POST /api/v1/datasets/from-feedback', () => {
  it('builds a dataset from selected feedback: input = captured variables, criteria = comment', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] })
      .expect(201);
    await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

    mockFetchOnce(CANNED_OPENAI);
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'greeting', alias: 'production', variables: { name: 'Al' } } })
      .expect(200);

    const trace = await prisma.trace.findFirst({ where: { teamId } });
    const fb = (
      await agent
        .post(`/api/v1/traces/${trace!.id}/feedback`)
        .send({ rating: -1, comment: 'Use third person, do not say I' })
        .expect(201)
    ).body;

    const res = await agent
      .post('/api/v1/datasets/from-feedback')
      .send({ name: 'unhappy-greetings', overall_feedback: 'Always third person', feedback_ids: [fb.id] })
      .expect(201);

    expect(res.body.example_count).toBe(1);
    expect(res.body.skipped).toEqual([]);

    const example = await prisma.datasetExample.findFirst({ where: { datasetId: res.body.id } });
    expect(example!.input).toEqual({ name: 'Al' });
    expect(example!.criteria).toBe('Use third person, do not say I');
    expect(example!.sourcePromptVersionId).not.toBeNull();
  });

  it('dedupes repeated feedback ids: the same id twice yields one example, not two', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] })
      .expect(201);
    await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

    mockFetchOnce(CANNED_OPENAI);
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'greeting', alias: 'production', variables: { name: 'Al' } } })
      .expect(200);

    const trace = await prisma.trace.findFirst({ where: { teamId } });
    const fb = (
      await agent.post(`/api/v1/traces/${trace!.id}/feedback`).send({ rating: -1, comment: 'Use third person' }).expect(201)
    ).body;

    const res = await agent
      .post('/api/v1/datasets/from-feedback')
      .send({ name: 'deduped', feedback_ids: [fb.id, fb.id] })
      .expect(201);

    expect(res.body.example_count).toBe(1);
    const count = await prisma.datasetExample.count({ where: { datasetId: res.body.id } });
    expect(count).toBe(1);
  });

  it('skips feedback whose source trace has no captured variables, 422 when none eligible', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);
    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'g2' }).expect(201)).body;
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Hi {{ name }}' }] })
      .expect(201);
    await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

    // Capture switched OFF for this call. It has to be explicit: the team
    // default is capture-ON (phase-3-faq Q25), so omitting the header would
    // record the variables and make this trace eligible after all.
    mockFetchOnce(CANNED_OPENAI);
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'false')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'g2', alias: 'production', variables: { name: 'Al' } } })
      .expect(200);
    const trace = await prisma.trace.findFirst({ where: { teamId } });
    const fb = (await agent.post(`/api/v1/traces/${trace!.id}/feedback`).send({ comment: 'x' }).expect(201)).body;

    await agent
      .post('/api/v1/datasets/from-feedback')
      .send({ name: 'empty', feedback_ids: [fb.id] })
      .expect(422);
  });

  it('skips a feedback row whose captured variables exceed the 8KB size cap, but still builds the dataset from the remaining eligible rows', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'g3' }).expect(201)).body;
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Hi {{ name }}' }] })
      .expect(201);
    await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

    // Small, eligible row.
    mockFetchOnce(CANNED_OPENAI);
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'g3', alias: 'production', variables: { name: 'Al' } } })
      .expect(200);
    const smallTrace = await prisma.trace.findFirst({ where: { teamId }, orderBy: { createdAt: 'desc' } });
    const smallFb = (
      await agent.post(`/api/v1/traces/${smallTrace!.id}/feedback`).send({ comment: 'good' }).expect(201)
    ).body;

    // Oversized row: captured variables alone exceed MAX_EXAMPLE_INPUT_BYTES (8192).
    // This exercises `buildFromFeedback` directly, since this bulk-import path
    // builds `input` server-side from a production trace payload rather than
    // through AddExampleSchema's Zod `.refine()`, so it needs its own enforcement.
    const oversizedName = 'x'.repeat(9000);
    mockFetchOnce(CANNED_OPENAI);
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'g3', alias: 'production', variables: { name: oversizedName } } })
      .expect(200);
    const largeTrace = await prisma.trace.findFirst({ where: { teamId }, orderBy: { createdAt: 'desc' } });
    const largeFb = (
      await agent.post(`/api/v1/traces/${largeTrace!.id}/feedback`).send({ comment: 'too big' }).expect(201)
    ).body;

    const res = await agent
      .post('/api/v1/datasets/from-feedback')
      .send({ name: 'mixed-sizes', feedback_ids: [smallFb.id, largeFb.id] })
      .expect(201);

    expect(res.body.example_count).toBe(1);
    expect(res.body.skipped).toEqual([
      { feedbackId: largeFb.id, reason: expect.stringContaining('exceeds 8192 bytes') },
    ]);

    const examples = await prisma.datasetExample.findMany({ where: { datasetId: res.body.id } });
    expect(examples).toHaveLength(1);
    expect(examples[0]!.input).toEqual({ name: 'Al' });
  });

  it('422 when every requested feedback row is oversized (none eligible)', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'g4' }).expect(201)).body;
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Hi {{ name }}' }] })
      .expect(201);
    await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

    const oversizedName = 'x'.repeat(9000);
    mockFetchOnce(CANNED_OPENAI);
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'g4', alias: 'production', variables: { name: oversizedName } } })
      .expect(200);
    const trace = await prisma.trace.findFirst({ where: { teamId } });
    const fb = (await agent.post(`/api/v1/traces/${trace!.id}/feedback`).send({ comment: 'too big' }).expect(201)).body;

    const res = await agent
      .post('/api/v1/datasets/from-feedback')
      .send({ name: 'all-oversized', feedback_ids: [fb.id] })
      .expect(422);

    expect(res.body.error.code).toBe('UNPROCESSABLE');
    expect(await prisma.dataset.count({ where: { teamId } })).toBe(0);
  });

  it('a missing feedback id is skipped with reason "feedback not found", 422 when it is the only one', async () => {
    const { agent } = await authedAgent(app);

    const res = await agent
      .post('/api/v1/datasets/from-feedback')
      .send({ name: 'missing', feedback_ids: ['00000000-0000-0000-0000-000000000000'] })
      .expect(422);

    expect(res.body.error.code).toBe('UNPROCESSABLE');
  });

  it('team isolation: team B cannot build a dataset from team A feedback ids (skipped, 422)', async () => {
    const a = await authedAgent(app);
    const credA = await createConnection(a.agent);
    await registerModel(a.agent, credA);

    const prompt = (await a.agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
    await a.agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] })
      .expect(201);
    await a.agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

    mockFetchOnce(CANNED_OPENAI);
    await a.agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'greeting', alias: 'production', variables: { name: 'Al' } } })
      .expect(200);
    const trace = await prisma.trace.findFirst({ where: { teamId: a.teamId } });
    const fb = (
      await a.agent.post(`/api/v1/traces/${trace!.id}/feedback`).send({ rating: 1, comment: 'x' }).expect(201)
    ).body;

    const b = await authedAgent(app);
    await b.agent
      .post('/api/v1/datasets/from-feedback')
      .send({ name: 'cross-team', feedback_ids: [fb.id] })
      .expect(422);

    expect(await prisma.dataset.count({ where: { teamId: b.teamId } })).toBe(0);
  });
});

describe('dataset CRUD', () => {
  it('creates an empty dataset, GET returns overall_feedback, PATCH updates name + overall_feedback', async () => {
    const { agent } = await authedAgent(app);

    const created = (
      await agent.post('/api/v1/datasets').send({ name: 'my-set', overall_feedback: 'Be concise' }).expect(201)
    ).body;
    expect(created.name).toBe('my-set');
    expect(created.overallFeedback).toBe('Be concise');
    expect(created.exampleCount).toBe(0);

    const fetched = (await agent.get(`/api/v1/datasets/${created.id}`).expect(200)).body;
    expect(fetched.overallFeedback).toBe('Be concise');

    const updated = (
      await agent
        .patch(`/api/v1/datasets/${created.id}`)
        .send({ name: 'renamed-set', overall_feedback: 'Be verbose' })
        .expect(200)
    ).body;
    expect(updated.name).toBe('renamed-set');
    expect(updated.overallFeedback).toBe('Be verbose');
  });

  it('list excludes soft-deleted datasets; GET on a soft-deleted dataset returns 404', async () => {
    const { agent } = await authedAgent(app);

    const created = (await agent.post('/api/v1/datasets').send({ name: 'to-delete' }).expect(201)).body;
    await agent.post('/api/v1/datasets').send({ name: 'to-keep' }).expect(201);

    await agent.delete(`/api/v1/datasets/${created.id}`).expect(200);

    const list = (await agent.get('/api/v1/datasets').expect(200)).body;
    expect(list.data.map((d: { name: string }) => d.name)).toEqual(['to-keep']);

    await agent.get(`/api/v1/datasets/${created.id}`).expect(404);
  });

  it('adds an example manually then deletes it', async () => {
    const { agent } = await authedAgent(app);
    const created = (await agent.post('/api/v1/datasets').send({ name: 'manual' }).expect(201)).body;

    const example = (
      await agent
        .post(`/api/v1/datasets/${created.id}/examples`)
        .send({ input: { name: 'Bob' }, criteria: 'Say hi politely' })
        .expect(201)
    ).body;
    expect(example.input).toEqual({ name: 'Bob' });
    expect(example.criteria).toBe('Say hi politely');

    const withExample = (await agent.get(`/api/v1/datasets/${created.id}`).expect(200)).body;
    expect(withExample.exampleCount).toBe(1);

    await agent.delete(`/api/v1/datasets/${created.id}/examples/${example.id}`).expect(200);

    const afterDelete = (await agent.get(`/api/v1/datasets/${created.id}`).expect(200)).body;
    expect(afterDelete.exampleCount).toBe(0);
  });

  it('rejects an oversized example input with a clear validation error (Finding #24)', async () => {
    const { agent } = await authedAgent(app);
    const created = (await agent.post('/api/v1/datasets').send({ name: 'oversized' }).expect(201)).body;

    const res = await agent
      .post(`/api/v1/datasets/${created.id}/examples`)
      .send({ input: { blob: 'x'.repeat(20_000) } })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    const withExample = (await agent.get(`/api/v1/datasets/${created.id}`).expect(200)).body;
    expect(withExample.exampleCount).toBe(0);
  });

  it('still accepts a normal-sized example input', async () => {
    const { agent } = await authedAgent(app);
    const created = (await agent.post('/api/v1/datasets').send({ name: 'normal-size' }).expect(201)).body;

    await agent
      .post(`/api/v1/datasets/${created.id}/examples`)
      .send({ input: { name: 'Bob', context: 'a normal-sized paragraph of prompt variables' } })
      .expect(201);
  });

  it('team isolation: team B GET of team A dataset returns 404', async () => {
    const a = await authedAgent(app);
    const created = (await a.agent.post('/api/v1/datasets').send({ name: 'a-only' }).expect(201)).body;

    const b = await authedAgent(app);
    await b.agent.get(`/api/v1/datasets/${created.id}`).expect(404);
  });

  it('returns 401 with no auth', async () => {
    await request(app).get('/api/v1/datasets').expect(401);
    await request(app).post('/api/v1/datasets').send({ name: 'x' }).expect(401);
  });
});
