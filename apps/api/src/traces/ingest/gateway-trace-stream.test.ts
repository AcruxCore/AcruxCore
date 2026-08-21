import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

/** Build a mock streaming fetch Response whose body emits the given SSE frames. */
function sseResponse(frames: string[], status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

/** Frames spelling "Hello" that also report provider usage. */
const FRAMES_WITH_USAGE = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
  'data: [DONE]\n\n',
];

/** Frames carrying one tool call, arguments split across two deltas (the real wire shape). */
const FRAMES_WITH_TOOL_CALLS = [
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"NYC\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}\n\n',
  'data: [DONE]\n\n',
];

async function createOpenAiConnection(agent: ReturnType<typeof request.agent>): Promise<void> {
  const res = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'test', apiKey: 'sk-live-test', config: {} })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: res.body.id })
    .expect(201);
}

/** Fire a streamed completion with the given trace headers. */
function streamComplete(
  agent: ReturnType<typeof request.agent>,
  headers: Record<string, string> = {},
  frames: string[] = FRAMES_WITH_USAGE,
): request.Test {
  jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(frames));
  const req = agent
    .post('/api/v1/gateway/chat/completions')
    .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Say hi' }], stream: true });
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

describe('gateway auto-trace hook — streaming (T1)', () => {
  it('a streamed completion creates one single-span trace mirroring the ledger row', async () => {
    const { agent, teamId } = await authedAgent(app);
    await createOpenAiConnection(agent);

    await streamComplete(agent).expect(200);

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
    expect(spans[0].totalTokens).toBe(7); // provider-reported, not estimated
    expect(Number(spans[0].costUsd)).toBeCloseTo(Number(gwRow.costUsd), 9);
    expect(spans[0].status).toBe('ok');
  });

  it('returns x-gateway-trace-id + x-gateway-span-id on the streamed response, matching what was written', async () => {
    const { agent, teamId } = await authedAgent(app);
    await createOpenAiConnection(agent);

    // The headers must be flushed BEFORE the first chunk, while the span is only
    // written at stream end — so the ids have to be minted up front.
    const res = await streamComplete(agent).expect(200);

    const traceId = res.headers['x-gateway-trace-id'];
    const spanRef = res.headers['x-gateway-span-id'];
    expect(traceId).toBeDefined();
    expect(spanRef).toBeDefined();

    const trace = await prisma.trace.findFirst({ where: { teamId } });
    expect(trace!.id).toBe(traceId);
    const span = await prisma.span.findFirst({ where: { teamId } });
    expect(span!.spanRef).toBe(spanRef);
  });

  it('a streamed completion honours x-trace-id + x-trace-name (no second trace)', async () => {
    const { agent, teamId } = await authedAgent(app);
    await createOpenAiConnection(agent);

    const traceId = '3f1d3a1e-9c1e-4a3e-8b2a-7c9d0e1f2a3b';
    const res = await streamComplete(agent, {
      'x-trace-id': traceId,
      'x-trace-name': encodeURIComponent('weather-tool-agent-stream'),
    }).expect(200);

    expect(res.headers['x-gateway-trace-id']).toBe(traceId);

    const traces = await prisma.trace.findMany({ where: { teamId } });
    expect(traces).toHaveLength(1);
    expect(traces[0].id).toBe(traceId);
    expect(traces[0].name).toBe('weather-tool-agent-stream');
    expect(traces[0].spanCount).toBe(1);
  });

  it('a streamed tool-calling turn stores the assembled tool_calls in the span payload', async () => {
    const { agent, teamId } = await authedAgent(app);
    await createOpenAiConnection(agent);

    await streamComplete(agent, {}, FRAMES_WITH_TOOL_CALLS).expect(200);

    const span = await prisma.span.findFirst({ where: { teamId } });
    const payload = await prisma.spanPayload.findFirst({ where: { spanId: span!.id } });
    expect(payload).not.toBeNull();

    // A streamed turn returns no whole message, so the hook has to reassemble the
    // fragmented argument deltas — otherwise the trace shows an empty output.
    const output = payload!.output as {
      choices: { message: { tool_calls?: { function: { name: string; arguments: string } }[] } }[];
    };
    const calls = output.choices[0].message.tool_calls;
    expect(calls).toHaveLength(1);
    expect(calls![0].function.name).toBe('get_weather');
    expect(JSON.parse(calls![0].function.arguments)).toEqual({ city: 'NYC' });
  });

  it('stamps a client-supplied prompt_version_id on the streamed span and row, and never sends it upstream', async () => {
    const { agent, teamId } = await authedAgent(app);
    await createOpenAiConnection(agent);

    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
    const v1 = await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] })
      .expect(201);

    // The streaming path stamps and strips in its own code, separate from the
    // non-streaming one, so covering that one proves nothing about this one.
    let providerBody: Record<string, unknown> = {};
    jest.spyOn(global, 'fetch').mockImplementation((_url, init) => {
      providerBody = JSON.parse(init && typeof init.body === 'string' ? init.body : '{}');
      return Promise.resolve(sseResponse(FRAMES_WITH_USAGE));
    });

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Say hi to Al' }],
        prompt_version_id: v1.body.id,
        stream: true,
      })
      .expect(200);

    const span = await prisma.span.findFirst({ where: { teamId } });
    expect(span!.promptVersionId).toBe(v1.body.id);
    const row = await prisma.gatewayRequest.findFirst({ where: { teamId } });
    expect(row!.promptVersionId).toBe(v1.body.id);

    // It is our field, not OpenAI's — an unknown key can make a provider 400.
    expect(providerBody).not.toHaveProperty('prompt_version_id');
  });

  it('a client-supplied parent span ref nests the streamed llm span under it', async () => {
    const { agent, teamId } = await authedAgent(app);
    await createOpenAiConnection(agent);

    // Turn 1 mints the trace and its span; turn 2 nests under it.
    const first = await streamComplete(agent).expect(200);
    const traceId = first.headers['x-gateway-trace-id'];
    const parentRef = first.headers['x-gateway-span-id'];

    await streamComplete(agent, { 'x-trace-id': traceId, 'x-parent-span-id': parentRef }).expect(200);

    const traces = await prisma.trace.findMany({ where: { teamId } });
    expect(traces).toHaveLength(1);
    expect(traces[0].spanCount).toBe(2);

    const child = await prisma.span.findFirst({ where: { teamId, parentSpanRef: parentRef } });
    expect(child).not.toBeNull();
  });
});
