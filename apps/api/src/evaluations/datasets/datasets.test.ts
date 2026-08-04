import request from 'supertest';
import { randomUUID } from 'node:crypto';
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

  it('captures prior-turn history (incl. a tool round trip) when the feedback trace belongs to a session', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);
    const turn2TraceId = randomUUID();

    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'support-followup' }).expect(201)).body;
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: '{{ message }}' }] })
      .expect(201);
    await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

    // Turn 1 — plain exchange, tags the session.
    mockFetchOnce({
      ...CANNED_OPENAI,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Sure, what is your order number?' }, finish_reason: 'stop' }],
    });
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .set('x-session-id', 'sess-1')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'My order is late' }] })
      .expect(200);

    // Turn 2 — a tool round trip within one trace (shared x-trace-id).
    mockFetchOnce({
      ...CANNED_OPENAI,
      choices: [{
        index: 0,
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '{"orderId":"123"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    });
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .set('x-session-id', 'sess-1')
      .set('x-trace-id', turn2TraceId)
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Order 123' }] })
      .expect(200);

    mockFetchOnce({
      ...CANNED_OPENAI,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Order 123 ships tomorrow.' }, finish_reason: 'stop' }],
    });
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .set('x-session-id', 'sess-1')
      .set('x-trace-id', turn2TraceId)
      .send({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'user', content: 'Order 123' },
          // The client echoes back exactly what the first call returned — the
          // OpenAI adapter normalizes a null content to '' (openai.adapter.ts:146),
          // so a real follow-up call carries '', not null, at this position.
          {
            role: 'assistant', content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '{"orderId":"123"}' } }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '{"eta":"tomorrow"}' },
        ],
      })
      .expect(200);

    // Turn 3 — the flagged turn. Routed through a stored prompt (like the
    // other tests in this file) so `findSourceSpanPayload` has a
    // `promptVersionId`'d span to resolve — unrelated to history reconstruction,
    // which reads turns 1-2 straight off their raw span payloads regardless.
    mockFetchOnce({
      ...CANNED_OPENAI,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Anything else?' }, finish_reason: 'stop' }],
    });
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .set('x-session-id', 'sess-1')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'support-followup', alias: 'production', variables: { message: 'No wrong tone, too curt' } } })
      .expect(200);

    const flaggedTrace = await prisma.trace.findFirst({ where: { teamId, sessionId: 'sess-1' }, orderBy: { startedAt: 'desc' } });
    const fb = (
      await agent
        .post(`/api/v1/traces/${flaggedTrace!.id}/feedback`)
        .send({ rating: -1, comment: 'Too curt' })
        .expect(201)
    ).body;

    const res = await agent
      .post('/api/v1/datasets/from-feedback')
      .send({ name: 'session-history', feedback_ids: [fb.id] })
      .expect(201);

    const dataset = await agent.get(`/api/v1/datasets/${res.body.id}`).expect(200);
    const example = dataset.body.examples[0];
    expect(example.history).toEqual([
      { role: 'user', content: 'My order is late' },
      { role: 'assistant', content: 'Sure, what is your order number?' },
      { role: 'user', content: 'Order 123' },
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '{"orderId":"123"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"eta":"tomorrow"}' },
      { role: 'assistant', content: 'Order 123 ships tomorrow.' },
    ]);
  });

  it('leaves history null when the feedback trace has no session', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'no-session-prompt' }).expect(201)).body;
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] })
      .expect(201);
    await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

    mockFetchOnce(CANNED_OPENAI);
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'no-session-prompt', alias: 'production', variables: { name: 'Al' } } })
      .expect(200);

    const trace = await prisma.trace.findFirst({ where: { teamId } });
    const fb = (
      await agent.post(`/api/v1/traces/${trace!.id}/feedback`).send({ rating: -1, comment: 'meh' }).expect(201)
    ).body;

    const res = await agent
      .post('/api/v1/datasets/from-feedback')
      .send({ name: 'no-session', feedback_ids: [fb.id] })
      .expect(201);

    const dataset = await agent.get(`/api/v1/datasets/${res.body.id}`).expect(200);
    expect(dataset.body.examples[0].history).toBeNull();
  });

  // Both published SDKs report an llm span as `input: {messages}` + `output:
  // <bare message>`, which is not the shape the gateway hook writes. Reading
  // only the gateway shape threw inside the reconstruction and 500'd the whole
  // request, so no dataset was created at all.
  it('reconstructs history from an SDK-reported prior turn, not only gateway-written spans', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    // Exactly what `@acruxcoreai/sdk`'s and `acruxcore`'s auto-trace posts.
    await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            name: 'chat',
            sessionId: 'sess-sdk',
            capturePayloads: true,
            spans: [
              {
                spanId: 's1',
                name: 'gpt-4o-mini',
                kind: 'llm',
                status: 'ok',
                startTime: '2026-08-01T10:00:00Z',
                endTime: '2026-08-01T10:00:01Z',
                model: 'gpt-4o-mini',
                provider: 'openai',
                input: { messages: [{ role: 'user', content: 'My order is late' }] },
                output: { role: 'assistant', content: 'What is your order number?' },
              },
            ],
          },
        ],
      })
      .expect(200);

    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'sdk-followup' }).expect(201)).body;
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: '{{ message }}' }] })
      .expect(201);
    await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

    mockFetchOnce(CANNED_OPENAI);
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .set('x-session-id', 'sess-sdk')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'sdk-followup', alias: 'production', variables: { message: 'Order 123' } } })
      .expect(200);

    const flagged = await prisma.trace.findFirst({
      where: { teamId, sessionId: 'sess-sdk' },
      orderBy: { startedAt: 'desc' },
    });
    const fb = (
      await agent.post(`/api/v1/traces/${flagged!.id}/feedback`).send({ rating: -1, comment: 'too curt' }).expect(201)
    ).body;

    const res = await agent
      .post('/api/v1/datasets/from-feedback')
      .send({ name: 'sdk-shaped-history', feedback_ids: [fb.id] })
      .expect(201);

    const dataset = await agent.get(`/api/v1/datasets/${res.body.id}`).expect(200);
    expect(dataset.body.examples[0].history).toEqual([
      { role: 'user', content: 'My order is late' },
      { role: 'assistant', content: 'What is your order number?' },
    ]);
  });

  // A gateway-path `chat({ trace: { sessionId } })` call produces TWO llm spans
  // for one turn: the gateway's own, plus the SDK's self-report. The turn must
  // appear once in the reconstructed history, not twice.
  it('does not duplicate a turn that both the gateway and the SDK reported', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    const priorTraceId = randomUUID();
    mockFetchOnce({
      ...CANNED_OPENAI,
      choices: [{ index: 0, message: { role: 'assistant', content: 'What is your order number?' }, finish_reason: 'stop' }],
    });
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .set('x-session-id', 'sess-dup')
      .set('x-trace-id', priorTraceId)
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'My order is late' }] })
      .expect(200);

    // The SDK's own report of that same exchange, into the same trace.
    await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            traceId: priorTraceId,
            capturePayloads: true,
            spans: [
              {
                spanId: 'sdk-self-report',
                name: 'gpt-4o-mini',
                kind: 'llm',
                status: 'ok',
                startTime: '2026-08-01T10:00:00Z',
                endTime: '2026-08-01T10:00:01Z',
                input: { messages: [{ role: 'user', content: 'My order is late' }] },
                output: { role: 'assistant', content: 'What is your order number?' },
              },
            ],
          },
        ],
      })
      .expect(200);

    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'dup-followup' }).expect(201)).body;
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: '{{ message }}' }] })
      .expect(201);
    await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

    mockFetchOnce(CANNED_OPENAI);
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .set('x-session-id', 'sess-dup')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'dup-followup', alias: 'production', variables: { message: 'Order 123' } } })
      .expect(200);

    const flagged = await prisma.trace.findFirst({
      where: { teamId, sessionId: 'sess-dup', id: { not: priorTraceId } },
      orderBy: { startedAt: 'desc' },
    });
    const fb = (
      await agent.post(`/api/v1/traces/${flagged!.id}/feedback`).send({ rating: -1, comment: 'too curt' }).expect(201)
    ).body;

    const res = await agent
      .post('/api/v1/datasets/from-feedback')
      .send({ name: 'dup-history', feedback_ids: [fb.id] })
      .expect(201);

    const dataset = await agent.get(`/api/v1/datasets/${res.body.id}`).expect(200);
    expect(dataset.body.examples[0].history).toEqual([
      { role: 'user', content: 'My order is late' },
      { role: 'assistant', content: 'What is your order number?' },
    ]);
  });

  it('rejects a request drawing on more feedback rows than one build allows', async () => {
    const { agent } = await authedAgent(app);
    const tooMany = Array.from({ length: 101 }, () => randomUUID());
    await agent
      .post('/api/v1/datasets/from-feedback')
      .send({ name: 'too-many', feedback_ids: tooMany })
      .expect(400);
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

  it('accepts an optional history array on a manually-added example', async () => {
    const { agent } = await authedAgent(app);
    const dataset = (await agent.post('/api/v1/datasets').send({ name: 'manual-history' }).expect(201)).body;

    const res = await agent
      .post(`/api/v1/datasets/${dataset.id}/examples`)
      .send({
        input: { name: 'Al' },
        criteria: 'be concise',
        history: [
          { role: 'user', content: 'turn 1' },
          { role: 'assistant', content: 'reply 1' },
        ],
      })
      .expect(201);

    expect(res.body.history).toEqual([
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'reply 1' },
    ]);
  });

  it('rejects a history array with more messages than the cap allows', async () => {
    const { agent } = await authedAgent(app);
    const dataset = (await agent.post('/api/v1/datasets').send({ name: 'manual-too-many' }).expect(201)).body;

    const tooMany = Array.from({ length: 21 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    await agent
      .post(`/api/v1/datasets/${dataset.id}/examples`)
      .send({ input: {}, history: tooMany })
      .expect(400);
  });

  it('rejects a history array whose serialized size exceeds the cap', async () => {
    const { agent } = await authedAgent(app);
    const dataset = (await agent.post('/api/v1/datasets').send({ name: 'manual-oversized-history' }).expect(201)).body;

    const hugeContent = 'x'.repeat(40000);
    await agent
      .post(`/api/v1/datasets/${dataset.id}/examples`)
      .send({ input: {}, history: [{ role: 'user', content: hugeContent }] })
      .expect(400);
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
