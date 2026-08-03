import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { SpansRepository } from '../spans/spans.repository';
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

async function signupOwner(): Promise<{ agent: ReturnType<typeof request.agent>; teamId: string; userId: string }> {
  const { agent, teamId, userId } = await authedAgent(app);
  return { agent, teamId, userId };
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

// Not async: returning the supertest `Test` (a thenable) directly from an async
// function makes TS unwrap it to `Response` at the call site (losing `.expect`).
function complete(agent: ReturnType<typeof request.agent>, headers: Record<string, string> = {}): request.Test {
  mockFetchOnce(CANNED_OPENAI);
  const req = agent
    .post('/api/v1/gateway/chat/completions')
    .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Say hi.' }] });
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req;
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE span_payloads, spans, traces, team_trace_settings, gateway_requests, gateway_model_fallbacks, gateway_models, provider_connections, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await prisma.$disconnect();
});

describe('gateway auto-trace hook (T1)', () => {
  it('a completion with no trace headers creates exactly one single-span trace mirroring the ledger row', async () => {
    const { agent, teamId } = await signupOwner();
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    await complete(agent).expect(200);

    const traces = await prisma.trace.findMany({ where: { teamId } });
    expect(traces).toHaveLength(1);
    expect(traces[0].spanCount).toBe(1);

    const spans = await prisma.span.findMany({ where: { teamId } });
    expect(spans).toHaveLength(1);
    const gwRow = (await prisma.gatewayRequest.findMany({ where: { teamId } }))[0];
    expect(spans[0].kind).toBe('llm');
    expect(spans[0].traceId).toBe(traces[0].id);
    expect(spans[0].gatewayRequestId).toBe(gwRow.id);
    expect(spans[0].model).toBe(gwRow.resolvedModel);
    expect(spans[0].totalTokens).toBe(gwRow.totalTokens);
    expect(Number(spans[0].costUsd)).toBeCloseTo(Number(gwRow.costUsd), 9);
    expect(spans[0].status).toBe('ok');
    expect(spans[0].parentSpanRef).toBeNull();
  });

  it('decodes a percent-encoded x-trace-name header into the trace name (Unicode-safe)', async () => {
    const { agent, teamId } = await signupOwner();
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    // Free-text names may hold any Unicode; the client percent-encodes them so
    // the header stays ISO-8859-1 (a raw em-dash/CJK char makes fetch throw).
    const name = 'Tell me — café 日本';
    await complete(agent, { 'x-trace-name': encodeURIComponent(name) }).expect(200);

    const trace = (await prisma.trace.findMany({ where: { teamId } }))[0];
    expect(trace.name).toBe(name);
  });

  it('falls back to the raw x-trace-name when it is not percent-encoded (older clients)', async () => {
    const { agent, teamId } = await signupOwner();
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    await complete(agent, { 'x-trace-name': 'runToolLoop' }).expect(200);

    const trace = (await prisma.trace.findMany({ where: { teamId } }))[0];
    expect(trace.name).toBe('runToolLoop');
  });

  it('a completion with x-trace-id appends under the existing trace (span_count increments, no new trace) and sets parent_span_ref', async () => {
    const { agent, teamId } = await signupOwner();
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    await complete(agent).expect(200);
    const firstTrace = (await prisma.trace.findMany({ where: { teamId } }))[0];

    await complete(agent, { 'x-trace-id': firstTrace.id, 'x-parent-span-id': 'parent-abc' }).expect(200);

    const traces = await prisma.trace.findMany({ where: { teamId } });
    expect(traces).toHaveLength(1); // no new trace
    expect(traces[0].spanCount).toBe(2);

    const appended = (await prisma.span.findMany({ where: { teamId }, orderBy: { createdAt: 'asc' } }))[1];
    expect(appended.parentSpanRef).toBe('parent-abc');
    expect(appended.traceId).toBe(firstTrace.id);
  });

  it('returns x-gateway-trace-id + x-gateway-span-id headers matching the created trace and span', async () => {
    const { agent, teamId } = await signupOwner();
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    const res = await complete(agent).expect(200);

    const trace = (await prisma.trace.findMany({ where: { teamId } }))[0];
    const span = (await prisma.span.findMany({ where: { teamId } }))[0];
    expect(res.headers['x-gateway-trace-id']).toBe(trace.id);
    expect(res.headers['x-gateway-span-id']).toBe(span.spanRef);
  });

  it('x-gateway-trace-id echoes the caller-supplied x-trace-id (one trace, nesting under it)', async () => {
    const { agent, teamId } = await signupOwner();
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    await complete(agent).expect(200);
    const firstTrace = (await prisma.trace.findMany({ where: { teamId } }))[0];

    const res = await complete(agent, { 'x-trace-id': firstTrace.id }).expect(200);
    expect(res.headers['x-gateway-trace-id']).toBe(firstTrace.id);

    const traces = await prisma.trace.findMany({ where: { teamId } });
    expect(traces).toHaveLength(1); // still one trace
  });

  it('sets prompt_version_id on the span when the call used a stored prompt reference', async () => {
    const { agent, teamId } = await signupOwner();
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
      .send({ model: 'gpt-4o-mini', prompt: { name: 'greeting', alias: 'production', variables: { name: 'Al' } } })
      .expect(200);

    const span = (await prisma.span.findMany({ where: { teamId } }))[0];
    expect(span.promptVersionId).not.toBeNull();
  });

  it('GET /traces/:id exposes captured prompt variables on the span payload', async () => {
    const { agent, teamId } = await signupOwner();
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
    const res = await agent.get(`/api/v1/traces/${trace!.id}`).expect(200);
    expect(res.body.spans[0].payload.variables).toEqual({ name: 'Al' });
  });

  it('a prompt-ref completion with capture on stores the RENDERED messages (not the raw template) as span_payloads.input', async () => {
    const { agent, teamId } = await signupOwner();
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

    const span = (await prisma.span.findMany({ where: { teamId } }))[0];
    expect(span.promptVersionId).not.toBeNull();

    const payload = await prisma.spanPayload.findFirst({ where: { teamId } });
    expect(payload).not.toBeNull();
    expect(payload!.input).toEqual([{ role: 'user', content: 'Say hi to Al' }]);
    expect((payload!.output as Record<string, unknown>).usage).toBeDefined();
  });

  it('a prompt-ref completion with capture on stores the raw variables as span_payloads.variables', async () => {
    const { agent, teamId } = await signupOwner();
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

    const payload = await prisma.spanPayload.findFirst({ where: { teamId } });
    expect(payload).not.toBeNull();
    expect(payload!.variables).toEqual({ name: 'Al' });
  });

  it('a raw-messages completion with capture on stores variables = null', async () => {
    const { agent, teamId } = await signupOwner();
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    mockFetchOnce(CANNED_OPENAI);
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Say hi.' }] })
      .expect(200);

    const payload = await prisma.spanPayload.findFirst({ where: { teamId } });
    expect(payload).not.toBeNull();
    expect(payload!.variables).toBeNull();
  });

  it('a prompt-ref completion with capture OFF writes no payload row (no variables leak)', async () => {
    const { agent, teamId } = await signupOwner();
    const credId = await createConnection(agent);
    await registerModel(agent, credId);
    await agent.put('/api/v1/traces/settings').send({ capturePayloads: false }).expect(200);

    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] })
      .expect(201);
    await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);

    mockFetchOnce(CANNED_OPENAI);
    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'greeting', alias: 'production', variables: { name: 'Al' } } })
      .expect(200);

    const payload = await prisma.spanPayload.findFirst({ where: { teamId } });
    expect(payload).toBeNull();
  });
});

describe('payload capture (T1, FAQ Q5)', () => {
  it('capture on by default → a span_payloads row with input messages + output', async () => {
    const { agent, teamId } = await signupOwner();
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    await complete(agent).expect(200);

    const payloads = await prisma.spanPayload.findMany({ where: { teamId } });
    expect(payloads).toHaveLength(1);
    expect(payloads[0].input).toEqual([{ role: 'user', content: 'Say hi.' }]);
    expect((payloads[0].output as Record<string, unknown>).usage).toBeDefined();
  });

  it('team default off (PUT settings) → no span_payloads row', async () => {
    const { agent, teamId } = await signupOwner();
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    await agent.put('/api/v1/traces/settings').send({ capturePayloads: false }).expect(200);
    await complete(agent).expect(200);

    expect(await prisma.spanPayload.count({ where: { teamId } })).toBe(0);
  });

  it('per-request x-capture-payloads:false skips even while the team default is on', async () => {
    const { agent, teamId } = await signupOwner();
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    await complete(agent, { 'x-capture-payloads': 'false' }).expect(200);

    expect(await prisma.spanPayload.count({ where: { teamId } })).toBe(0);
  });

  it('per-request x-capture-payloads:true captures even while the team default is off', async () => {
    const { agent, teamId } = await signupOwner();
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    await agent.put('/api/v1/traces/settings').send({ capturePayloads: false }).expect(200);
    await complete(agent, { 'x-capture-payloads': 'true' }).expect(200);

    const payloads = await prisma.spanPayload.findMany({ where: { teamId } });
    expect(payloads).toHaveLength(1);
    expect(payloads[0].input).toEqual([{ role: 'user', content: 'Say hi.' }]);
    expect((payloads[0].output as Record<string, unknown>).usage).toBeDefined();
  });
});

describe('best-effort guarantee (FAQ Q2/Q6)', () => {
  it('a forced appendSpan failure still returns 200 and leaves the gateway_requests cost row committed', async () => {
    const { agent, teamId } = await signupOwner();
    const credId = await createConnection(agent);
    await registerModel(agent, credId);

    jest.spyOn(SpansRepository.prototype, 'appendSpan').mockRejectedValue(new Error('boom'));
    const res = await complete(agent).expect(200);

    // The completion succeeded with the normal body.
    expect(res.body.choices[0].message.content).toBe('Hi');

    // The money row committed BEFORE the (failing) span write.
    const rows = await prisma.gatewayRequest.findMany({ where: { teamId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(Number(rows[0].costUsd)).toBeGreaterThan(0);

    // No span was written (the write threw and was swallowed).
    expect(await prisma.span.count({ where: { teamId } })).toBe(0);
  });
});

describe('team isolation', () => {
  it("team B's completion never appears in team A's traces", async () => {
    const a = await signupOwner();
    const credA = await createConnection(a.agent);
    await registerModel(a.agent, credA);
    await complete(a.agent).expect(200);

    const b = await signupOwner();
    const credB = await createConnection(b.agent);
    await registerModel(b.agent, credB);
    await complete(b.agent).expect(200);

    expect(await prisma.trace.count({ where: { teamId: a.teamId } })).toBe(1);
    expect(await prisma.trace.count({ where: { teamId: b.teamId } })).toBe(1);
    const aSpans = await prisma.span.findMany({ where: { teamId: a.teamId } });
    expect(aSpans.every((s) => s.teamId === a.teamId)).toBe(true);
  });
});
