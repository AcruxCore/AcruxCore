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

/** OpenAI streaming frames that spell "Hello" and report usage. */
const OPENAI_FRAMES_WITH_USAGE = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
  'data: [DONE]\n\n',
];

/** Same content but NO usage frame — forces estimation. */
const OPENAI_FRAMES_NO_USAGE = [
  'data: {"choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
];

/** OpenAI streaming frames carrying a single tool call, split across two deltas. */
const OPENAI_FRAMES_WITH_TOOL_CALLS = [
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"NYC\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: [DONE]\n\n',
];

/** Create an OpenAI credential AND register a `gpt-4o-mini` model on it. */
async function createOpenAiConnection(agent: ReturnType<typeof request.agent>): Promise<string> {
  const res = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'test', apiKey: 'sk-live-test', config: {} })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: res.body.id })
    .expect(201);
  return res.body.id;
}

/** Parse an SSE response body (res.text) into an array of data payload strings. */
function parseSse(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
}

async function truncate(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE gateway_requests, budgets, provider_connections, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE',
  );
}

beforeEach(truncate);
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
});

describe('POST /gateway/chat/completions (stream)', () => {
  it('streams ordered chunks ending [DONE], concatenated deltas equal the message, and records one costed row', async () => {
    const { agent, teamId } = await authedAgent(app);
    await createOpenAiConnection(agent);
    jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(OPENAI_FRAMES_WITH_USAGE));

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Say hi' }], stream: true })
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    const payloads = parseSse(res.text);
    expect(payloads[payloads.length - 1]).toBe('[DONE]');
    expect(res.headers['x-gateway-cost-usd']).toBeUndefined(); // omitted for streams
    expect(res.headers['x-gateway-request-id']).toBeDefined();
    expect(res.headers['x-gateway-provider']).toBe('openai');

    const dataFrames = payloads.filter((p) => p !== '[DONE]').map((p) => JSON.parse(p));
    const text = dataFrames.map((f) => f.choices[0].delta.content ?? '').join('');
    expect(text).toBe('Hello');
    expect(dataFrames[0].object).toBe('chat.completion.chunk');

    const rows = await prisma.gatewayRequest.findMany({ where: { teamId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].completionTokens).toBeGreaterThan(0);
    expect(Number(rows[0].costUsd)).toBeGreaterThan(0);
    // Persisted row id matches the header id flushed before the row was written.
    expect(rows[0].id).toBe(res.headers['x-gateway-request-id']);
  });

  it('estimates usage and marks meta.usageEstimated when the provider omits usage', async () => {
    const { agent, teamId } = await authedAgent(app);
    await createOpenAiConnection(agent);
    jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(OPENAI_FRAMES_NO_USAGE));

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Say hi' }], stream: true })
      .expect(200);

    const row = await prisma.gatewayRequest.findFirstOrThrow({ where: { teamId } });
    expect(row.completionTokens).toBeGreaterThan(0);
    expect((row.meta as Record<string, unknown>).usageEstimated).toBe(true);
  });

  it('returns 402 JSON with no stream when a budget is already exceeded', async () => {
    const { agent, teamId } = await authedAgent(app);
    await createOpenAiConnection(agent);

    const budgetRes = await agent
      .post('/api/v1/gateway/budgets')
      .send({ virtualKeyId: null, period: 'total', limitUsd: 0.01 })
      .expect(201);
    await prisma.budget.update({ where: { id: budgetRes.body.id }, data: { spendUsd: 0.02 } });

    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(OPENAI_FRAMES_WITH_USAGE));

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true })
      .expect(402);

    expect(res.body.error.code).toBe('BUDGET_EXCEEDED');
    expect(fetchSpy).not.toHaveBeenCalled(); // provider never contacted
    const rows = await prisma.gatewayRequest.findMany({ where: { teamId } });
    expect(rows).toHaveLength(0);
  });

  it('returns 502 JSON when the provider errors before the first chunk', async () => {
    const { agent } = await authedAgent(app);
    await createOpenAiConnection(agent);
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{"error":{"message":"upstream down"}}', { status: 500 }));

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true })
      .expect(502);

    expect(res.body.error.code).toBe('PROVIDER_ERROR');
  });

  it('a non-provider exception before the first chunk still credits the budget reservation back in full (no permanent leak)', async () => {
    // Regression: in `completeStream`, the per-deployment selection loop only
    // credited the reservation back via `recordStreamRow`'s 'error' path when
    // EVERY deployment raised a `ProviderError`. Any OTHER exception type (a
    // real bug, not a provider HTTP error) was rethrown immediately, bypassing
    // that accounting and permanently leaking the reservation. Corrupting the
    // stored connection's ciphertext makes `decryptSecret` throw a genuine
    // (non-`ProviderError`) `Error` for real, before any provider stream is
    // even attempted — no internal code is mocked, only real DB state is
    // manipulated.
    const { agent, teamId } = await authedAgent(app);
    const credId = await createOpenAiConnection(agent);

    const budgetRes = await agent
      .post('/api/v1/gateway/budgets')
      .send({ virtualKeyId: null, period: 'total', limitUsd: 10 })
      .expect(201);

    await prisma.providerConnection.update({
      where: { id: credId },
      data: { secretCiphertext: Buffer.from('not a valid iv+authTag+ciphertext payload!!') },
    });

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true })
      .expect(500);

    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    consoleErrorSpy.mockRestore();

    const budget = await prisma.budget.findUniqueOrThrow({ where: { id: budgetRes.body.id } });
    expect(budget.spendUsd.toNumber()).toBe(0);

    const rows = await prisma.gatewayRequest.findMany({ where: { teamId } });
    expect(rows).toHaveLength(0);
  });

  it('emits a terminal error frame and records status=error when the provider fails after the first chunk', async () => {
    const { agent, teamId } = await authedAgent(app);
    await createOpenAiConnection(agent);

    // NOTE: enqueue + error in the same start() would discard the queued chunk
    // (the spec resets the queue on error), so the error would hit before the
    // first chunk. Deliver the first chunk on pull #1, then error on pull #2 so
    // the failure is genuinely mid-stream (after the first byte is committed).
    const enc = new TextEncoder();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(
            enc.encode('data: {"choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n'),
          );
        } else {
          controller.error(new Error('connection reset'));
        }
      },
    });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true })
      .expect(200); // headers already flushed on the first chunk

    const payloads = parseSse(res.text);
    const errorFrame = payloads
      .filter((p) => p !== '[DONE]')
      .map((p) => JSON.parse(p))
      .find((f) => f.error);
    expect(errorFrame.error.code).toBeDefined();
    expect(payloads[payloads.length - 1]).toBe('[DONE]');

    const row = await prisma.gatewayRequest.findFirstOrThrow({ where: { teamId } });
    expect(row.status).toBe('error');
  });

  it('aborts the provider stream and records a partial row when the client disconnects', async () => {
    const { agent, teamId } = await authedAgent(app);
    await createOpenAiConnection(agent);

    const enc = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode('data: {"choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n'),
        );
        // deliberately never close — waits for cancel
      },
      cancel() {
        cancelled = true; // provider stream torn down on abort
      },
    });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const req = agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true });

    const pending = req.then(
      () => undefined,
      () => undefined, // aborting rejects the supertest promise — swallow it
    );
    await new Promise((r) => setTimeout(r, 80));
    req.abort();
    await pending;

    // Give finalize() a tick to persist after the 'close' event fires.
    await new Promise((r) => setTimeout(r, 200));

    expect(cancelled).toBe(true);
    const row = await prisma.gatewayRequest.findFirstOrThrow({ where: { teamId } });
    expect((row.meta as Record<string, unknown>).clientAborted).toBe(true);
    expect(row.completionTokens).toBeGreaterThanOrEqual(0);
  });

  it('surfaces tool_calls deltas in the SSE frames (TC2 Task 5)', async () => {
    const { agent } = await authedAgent(app);
    await createOpenAiConnection(agent);
    jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(OPENAI_FRAMES_WITH_TOOL_CALLS));

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ type: 'function', function: { name: 'get_weather' } }],
        stream: true,
      })
      .expect(200);

    const dataFrames = parseSse(res.text)
      .filter((p) => p !== '[DONE]')
      .map((p) => JSON.parse(p));
    const toolCallFrames = dataFrames.filter((f) => f.choices[0].delta.tool_calls);
    expect(toolCallFrames.length).toBeGreaterThan(0);
    expect(toolCallFrames[0].choices[0].delta.tool_calls[0].function.name).toBe('get_weather');
    expect(toolCallFrames[1].choices[0].delta.tool_calls[0].function.arguments).toBe('{"city":"NYC"}');
  });

  it('#12: streams using the version-bound model when the request omits model', async () => {
    const { agent, teamId } = await authedAgent(app);
    await createOpenAiConnection(agent);
    // Bind v1 of a prompt to the registered model (auto-creates production).
    const p = await agent.post('/api/v1/prompts').send({ name: 'streambound' }).expect(201);
    await agent
      .post(`/api/v1/prompts/${p.body.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Say hi' }], model: 'gpt-4o-mini' })
      .expect(201);
    jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(OPENAI_FRAMES_WITH_USAGE));

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ prompt: { name: 'streambound', alias: 'production' }, stream: true }) // no model
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    const payloads = parseSse(res.text);
    expect(payloads[payloads.length - 1]).toBe('[DONE]');

    const rows = await prisma.gatewayRequest.findMany({ where: { teamId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].requestedModel).toBe('gpt-4o-mini'); // resolved from the binding
    expect(rows[0].status).toBe('success');
  });
});
