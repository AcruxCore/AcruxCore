import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { computeCostFromPrices, lookupDefaultPricing } from '../providers/models';
import type { Usage } from '../providers/types';
import { authedAgent } from '../../test-utils';

const app = createApp();

/** Expected cost for a known upstream model using the same prefill prices a model gets on registration. */
function expectedCost(upstream: string, usage: Usage): number {
  const p = lookupDefaultPricing(upstream)!;
  return computeCostFromPrices(p.inputPricePerM, p.outputPricePerM, usage)!;
}

const CANNED_OPENAI = {
  id: 'chatcmpl-int',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
};

const CANNED_ANTHROPIC = {
  id: 'msg_int',
  type: 'message',
  role: 'assistant',
  model: 'claude-3-5-sonnet-latest',
  content: [{ type: 'text', text: 'Hi' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 15, output_tokens: 2 },
};

const CANNED_GEMINI = {
  candidates: [
    { content: { parts: [{ text: 'Hi' }], role: 'model' }, finishReason: 'STOP', index: 0 },
  ],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1, totalTokenCount: 13 },
};

function mockFetchOnce(body: unknown, ok = true, status = 200): void {
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response);
}

/** Parses the JSON body of the most recent mocked provider request set up via `mockFetchOnce`. */
function lastProviderRequestBody(): Record<string, unknown> {
  const calls = (global.fetch as jest.Mock).mock.calls;
  const [, init] = calls[calls.length - 1] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

async function createConnection(
  agent: ReturnType<typeof request.agent>,
  provider: 'openai' | 'anthropic' | 'openai_compatible' | 'gemini',
  apiKey: string,
  config: Record<string, unknown> = {},
): Promise<string> {
  const res = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider, label: `${provider} test`, apiKey, config })
    .expect(201);
  return res.body.id;
}

/**
 * Registers a model whose public name equals its upstream name (so mocked tests
 * can call `model: '<name>'`), bound to the given credential. Prices are prefilled
 * from the static registry for known ids.
 */
async function registerModel(
  agent: ReturnType<typeof request.agent>,
  credentialId: string,
  name: string,
): Promise<string> {
  const res = await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: name, upstreamModel: name, credentialId })
    .expect(201);
  return res.body.id;
}

/**
 * Signs up a new team owner, connects an OpenAI credential, registers a
 * `gpt-4o-mini` model (so `CANNED_OPENAI`'s model matches), and mints a personal
 * API key for that owner. Returns the pieces needed to hit the gateway via
 * `Authorization: Bearer <apiKey>` instead of a session cookie.
 */
async function setupTeamWithOpenAiModel(): Promise<{
  apiKey: string;
  model: string;
  agent: ReturnType<typeof request.agent>;
}> {
  const { agent } = await authedAgent(app);
  const credId = await createConnection(agent, 'openai', 'sk-test-abcdAB12');
  const model = 'gpt-4o-mini';
  await registerModel(agent, credId, model);
  const keyRes = await agent.post('/api/v1/api-keys').send({ name: 'tools passthrough test key' }).expect(201);
  return { apiKey: keyRes.body.key as string, model, agent };
}

/**
 * Signs up a new team owner, connects an Anthropic credential, registers a
 * `claude-3-5-sonnet-latest` model (so `CANNED_ANTHROPIC`'s model matches), and
 * mints a personal API key for that owner. Returns the pieces needed to hit the
 * gateway via `Authorization: Bearer <apiKey>` instead of a session cookie.
 * Mirrors `setupTeamWithOpenAiModel`, using the same connect+register+key-mint
 * pattern already exercised inline by the plain Anthropic completions test above.
 */
async function setupTeamWithAnthropicModel(): Promise<{ apiKey: string; model: string }> {
  const { agent } = await authedAgent(app);
  const credId = await createConnection(agent, 'anthropic', 'anthropic-test-key');
  const model = 'claude-3-5-sonnet-latest';
  await registerModel(agent, credId, model);
  const keyRes = await agent.post('/api/v1/api-keys').send({ name: 'tools passthrough test key' }).expect(201);
  return { apiKey: keyRes.body.key as string, model };
}

/**
 * Signs up a new team owner, connects a Gemini credential, registers a
 * `gemini-1.5-flash` model (matching the plain Gemini completions test above; the
 * Gemini adapter's `normalize` sets the response `model` from `req.model` directly
 * rather than reading it off the response body, so `CANNED_GEMINI` needs no `model`
 * field), and mints a personal API key for that owner. Mirrors
 * `setupTeamWithAnthropicModel`'s connect+register+key-mint pattern.
 */
async function setupTeamWithGeminiModel(): Promise<{ apiKey: string; model: string }> {
  const { agent } = await authedAgent(app);
  const credId = await createConnection(agent, 'gemini', 'g-test-key');
  const model = 'gemini-1.5-flash';
  await registerModel(agent, credId, model);
  const keyRes = await agent.post('/api/v1/api-keys').send({ name: 'tools passthrough test key' }).expect(201);
  return { apiKey: keyRes.body.key as string, model };
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE gateway_requests, provider_connections, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/v1/gateway/chat/completions (adapter-mocked)', () => {
  it('OpenAI call → 200 OpenAI-shaped body + gateway_requests row with tokens + matching cost', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent, 'openai', 'sk-test-abcdAB12');
    await registerModel(agent, credId, 'gpt-4o-mini');
    mockFetchOnce(CANNED_OPENAI);

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Say hi in one word.' }], max_tokens: 50 })
      .expect(200);

    // OpenAI-shaped body
    expect(res.body.choices[0].message.content).toBe('Hi');
    expect(res.body.usage.total_tokens).toBe(13);

    // Headers (Q4)
    expect(res.headers['x-gateway-provider']).toBe('openai');
    expect(res.headers['x-gateway-model']).toBe('gpt-4o-mini');
    expect(res.headers['x-gateway-cache']).toBe('miss');
    expect(res.headers['x-gateway-request-id']).toBeDefined();
    const cost = expectedCost('gpt-4o-mini', CANNED_OPENAI.usage);
    expect(Number(res.headers['x-gateway-cost-usd'])).toBeCloseTo(cost, 9);

    // DB row
    const rows = await prisma.gatewayRequest.findMany({ where: { teamId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('success');
    expect(rows[0]?.promptTokens).toBe(12);
    expect(rows[0]?.completionTokens).toBe(1);
    expect(Number(rows[0]?.costUsd)).toBeCloseTo(cost, 9);
    expect(rows[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('Anthropic call → 200 normalized body; usage mapped; success row', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent, 'anthropic', 'anthropic-test-key');
    await registerModel(agent, credId, 'claude-3-5-sonnet-latest');
    mockFetchOnce(CANNED_ANTHROPIC);

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'claude-3-5-sonnet-latest',
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'Say hi.' },
        ],
        max_tokens: 64,
      })
      .expect(200);

    expect(res.body.choices[0].message.content).toBe('Hi');
    expect(res.body.usage).toEqual({ prompt_tokens: 15, completion_tokens: 2, total_tokens: 17 });
    expect(res.headers['x-gateway-provider']).toBe('anthropic');

    const rows = await prisma.gatewayRequest.findMany({ where: { teamId } });
    expect(rows[0]?.promptTokens).toBe(15);
    expect(rows[0]?.completionTokens).toBe(2);
  });

  it('Gemini call → 200 normalized body; native generateContent endpoint; success row', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent, 'gemini', 'g-test-key');
    await registerModel(agent, credId, 'gemini-1.5-flash');
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => CANNED_GEMINI,
      text: async () => JSON.stringify(CANNED_GEMINI),
    } as unknown as Response);

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gemini-1.5-flash', messages: [{ role: 'user', content: 'Say hi.' }] })
      .expect(200);

    // OpenAI-shaped body
    expect(res.body.choices[0].message.content).toBe('Hi');
    expect(res.body.usage.total_tokens).toBe(13);
    expect(res.headers['x-gateway-provider']).toBe('gemini');

    // The adapter hit the Gemini native :generateContent endpoint.
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
    );

    // DB row — cost computed from the normalized (OpenAI-shaped) usage.
    const cost = expectedCost('gemini-1.5-flash', {
      prompt_tokens: 12,
      completion_tokens: 1,
      total_tokens: 13,
    });
    const rows = await prisma.gatewayRequest.findMany({ where: { teamId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe('gemini');
    expect(rows[0]?.status).toBe('success');
    expect(rows[0]?.promptTokens).toBe(12);
    expect(rows[0]?.promptTokens).toBeGreaterThan(0);
    expect(Number(rows[0]?.costUsd)).toBeCloseTo(cost, 9);
  });

  it('registered model with no price → still served, cost_usd null', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent, 'openai', 'sk-test-abcdAB12');
    // Unknown upstream id → no price prefill → cost logged null.
    await registerModel(agent, credId, 'gpt-4o-experimental');
    mockFetchOnce({ ...CANNED_OPENAI, model: 'gpt-4o-experimental' });

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-experimental', messages: [{ role: 'user', content: 'hi' }] })
      .expect(200);

    expect(res.body.choices[0].message.content).toBe('Hi');
    expect(res.headers['x-gateway-cost-usd']).toBe(''); // null → empty header

    const rows = await prisma.gatewayRequest.findMany({ where: { teamId } });
    expect(rows[0]?.status).toBe('success');
    expect(rows[0]?.costUsd).toBeNull();
    expect(rows[0]?.promptTokens).toBe(12);
  });

  // T1 additivity guard (Task 4): trace-context headers/body are read into the
  // controller's ctx but not yet wired into any consumer (Task 5/6), so there is
  // no new observable output to assert on here — this only proves the widened
  // GatewayCallContext + header/body merge does not change Phase 2 behaviour.
  it('T1: trace-context headers + body trace object present → 200, same body/row as without them', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent, 'openai', 'sk-test-abcdAB12');
    await registerModel(agent, credId, 'gpt-4o-mini');
    mockFetchOnce(CANNED_OPENAI);

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-trace-id', 'trace-abc')
      .set('x-parent-span-id', 'span-abc')
      .set('x-session-id', 'session-abc')
      .set('x-capture-payloads', 'true')
      .send({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Say hi in one word.' }],
        max_tokens: 50,
        // Body trace object is a fallback source; the schema strips it before it
        // reaches the adapter (superRefine only knows `messages`/`prompt`/`gateway`),
        // so it must not surface anywhere in the response.
        trace: { traceId: 'ignored-body-trace-id', parentSpanId: 'ignored', sessionId: 'ignored', capturePayloads: false },
      })
      .expect(200);

    expect(res.body.choices[0].message.content).toBe('Hi');
    expect(res.body.usage.total_tokens).toBe(13);
    expect(res.body.trace).toBeUndefined();
    expect(res.headers['x-gateway-provider']).toBe('openai');

    const rows = await prisma.gatewayRequest.findMany({ where: { teamId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('success');
  });

  it('T8: x-trace-name/x-trace-tags/x-trace-metadata headers are read into ctx (additivity guard)', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent, 'openai', 'sk-test-abcdAB12');
    await registerModel(agent, credId, 'gpt-4o-mini');
    mockFetchOnce(CANNED_OPENAI);

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-trace-name', 'checkout-flow')
      .set('x-trace-tags', 'prod, nl,')
      .set('x-trace-metadata', '{"env":"prod"}')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Say hi in one word.' }], max_tokens: 50 })
      .expect(200);

    expect(res.body.choices[0].message.content).toBe('Hi');
    expect(res.body.trace).toBeUndefined();

    // DB state: the trace-tags comma-split/trim/empty-filter transform actually ran.
    // recordGatewaySpan is awaited by the caller, so the row is guaranteed to exist here.
    const trace = await prisma.trace.findFirst({ where: { teamId } });
    expect(trace?.name).toBe('checkout-flow');
    expect([...(trace?.tags ?? [])].sort()).toEqual(['nl', 'prod']);
    expect(trace?.metadata).toEqual({ env: 'prod' });
  });

  it('T8: a malformed x-trace-metadata header is ignored (best-effort), request still succeeds', async () => {
    const { agent } = await authedAgent(app);
    const credId = await createConnection(agent, 'openai', 'sk-test-abcdAB12');
    await registerModel(agent, credId, 'gpt-4o-mini');
    mockFetchOnce(CANNED_OPENAI);

    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-trace-metadata', '{not-json')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Say hi in one word.' }], max_tokens: 50 })
      .expect(200);
  });

  it('T9: x-span-name/x-span-tags/x-span-metadata headers are read into ctx and land on the span', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent, 'openai', 'sk-test-abcdAB12');
    await registerModel(agent, credId, 'gpt-4o-mini');
    mockFetchOnce(CANNED_OPENAI);

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-span-name', 'detect-intent')
      .set('x-span-tags', 'prod, nl,')
      .set('x-span-metadata', '{"userId":"u_789"}')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Say hi in one word.' }], max_tokens: 50 })
      .expect(200);

    expect(res.body.choices[0].message.content).toBe('Hi');
    expect(res.body.span).toBeUndefined();

    const span = await prisma.span.findFirst({ where: { teamId } });
    expect(span?.name).toBe('detect-intent');
    expect([...(span?.tags ?? [])].sort()).toEqual(['nl', 'prod']);
    expect(span?.metadata).toEqual({ userId: 'u_789' });
  });

  it('T9: body `span` object is a fallback source for name/tags/metadata; headers win when both are present', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent, 'openai', 'sk-test-abcdAB12');
    await registerModel(agent, credId, 'gpt-4o-mini');
    mockFetchOnce(CANNED_OPENAI);

    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-span-name', 'header-name')
      .send({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Say hi in one word.' }],
        max_tokens: 50,
        span: { name: 'body-name', tags: ['from-body'], metadata: { k: 'v' } },
      })
      .expect(200);

    const span = await prisma.span.findFirst({ where: { teamId } });
    expect(span?.name).toBe('header-name'); // header wins over body
    expect(span?.tags).toEqual(['from-body']); // body is the only source for tags here
    expect(span?.metadata).toEqual({ k: 'v' });
  });

  it('unregistered model → 400 MODEL_NOT_REGISTERED', async () => {
    const { agent } = await authedAgent(app);
    // No model registered.
    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
      .expect(400);

    expect(res.body.error.code).toBe('MODEL_NOT_REGISTERED');
  });

  it('provider 500 → 502 PROVIDER_ERROR + error row recorded', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent, 'openai', 'sk-test-abcdAB12');
    await registerModel(agent, credId, 'gpt-4o-mini');
    mockFetchOnce('upstream boom', false, 500);

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
      .expect(502);

    expect(res.body.error.code).toBe('PROVIDER_ERROR');

    const rows = await prisma.gatewayRequest.findMany({ where: { teamId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('error');
    expect(rows[0]?.errorCode).toBe('500');
    expect(Number(rows[0]?.costUsd)).toBe(0);
  });

  it('a non-provider exception during the call still credits the budget reservation back in full (no permanent leak)', async () => {
    // Regression: budget reservation used to only be reconciled/credited back
    // for `FallbackExhaustedError` — any OTHER exception thrown while calling
    // the provider (a real bug, not a provider HTTP error) rethrew immediately
    // and skipped `reconcileBudgets` entirely, permanently consuming the
    // reservation. Corrupting the stored connection's ciphertext makes
    // `decryptSecret` throw a genuine (non-`ProviderError`) `Error` for real,
    // inside `callWithFallback`'s invoker — no internal code is mocked, only
    // real DB state is manipulated (the same pattern `seedSpend`-style tests
    // already use elsewhere).
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent, 'openai', 'sk-test-abcdAB12');
    await registerModel(agent, credId, 'gpt-4o-mini');

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
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
      .expect(500);

    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    consoleErrorSpy.mockRestore();

    // The reservation must be credited back in full — spend is exactly what it
    // was before the call (0), not permanently inflated by the failed attempt's
    // estimate.
    const budget = await prisma.budget.findUniqueOrThrow({ where: { id: budgetRes.body.id } });
    expect(budget.spendUsd.toNumber()).toBe(0);

    // No gateway_requests row either — this exception happens before any row
    // is written, mirroring the pre-existing FallbackExhaustedError behavior
    // only in that no cost is ever recorded, not in reusing its code path.
    const rows = await prisma.gatewayRequest.findMany({ where: { teamId } });
    expect(rows).toHaveLength(0);
  });

  it('invalid body (empty messages) → 400 VALIDATION_ERROR', async () => {
    const { agent } = await authedAgent(app);
    await createConnection(agent, 'openai', 'sk-test-abcdAB12');

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [] })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('viewer → 403', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    await createConnection(agent, 'openai', 'sk-test-abcdAB12');

    // Downgrade the owner to viewer in their own team via DB.
    await prisma.teamMember.update({
      where: { userId_teamId: { userId, teamId } },
      data: { role: 'viewer' },
    });

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  // B1: gateway renders ad-hoc templated `messages` when top-level `variables` is supplied.
  it('renders templated messages when variables are supplied', async () => {
    const { agent } = await authedAgent(app);
    const credId = await createConnection(agent, 'openai', 'sk-test-abcdAB12');
    await registerModel(agent, credId, 'gpt-4o-mini');
    mockFetchOnce(CANNED_OPENAI);

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hi {{ name }}, welcome to {{ place }}.' }],
        variables: { name: 'Alice', place: 'Wonderland' },
      })
      .expect(200);

    // The mocked provider records the body it received.
    const sent = lastProviderRequestBody();
    expect((sent.messages as { content: string }[])[0]?.content).toBe('Hi Alice, welcome to Wonderland.');
    expect(sent).not.toHaveProperty('variables'); // stripped, OpenAI-compatible
    expect(res.body.choices).toBeDefined();
  });

  it('does NOT render messages when variables are absent (backward compat)', async () => {
    const { agent } = await authedAgent(app);
    const credId = await createConnection(agent, 'openai', 'sk-test-abcdAB12');
    await registerModel(agent, credId, 'gpt-4o-mini');
    mockFetchOnce(CANNED_OPENAI);

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Keep {{ braces }} literal' }],
      })
      .expect(200);

    const sent = lastProviderRequestBody();
    expect((sent.messages as { content: string }[])[0]?.content).toBe('Keep {{ braces }} literal');
  });

  it('rejects prompt ref combined with top-level variables', async () => {
    const { agent } = await authedAgent(app);
    await createConnection(agent, 'openai', 'sk-test-abcdAB12');

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'x', alias: 'production' }, variables: { a: 1 } })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  describe('tools passthrough — validation', () => {
    it('accepts a request with inline OpenAI tools and a tool-role message', async () => {
      const { apiKey, model } = await setupTeamWithOpenAiModel();
      mockFetchOnce(CANNED_OPENAI);
      await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          model,
          messages: [
            { role: 'user', content: 'weather in Paris?' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: '{"tempC":18}' },
          ],
          tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
          tool_choice: 'auto',
        })
        .expect(200);
    });

    it('rejects a tool message with no tool_call_id', async () => {
      const { apiKey, model } = await setupTeamWithOpenAiModel();
      const res = await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ model, messages: [{ role: 'tool', content: 'x' }] })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it('accepts an assistant tool_calls message with content OMITTED entirely (valid OpenAI shape)', async () => {
      const { apiKey, model } = await setupTeamWithOpenAiModel();
      mockFetchOnce(CANNED_OPENAI);
      await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          model,
          messages: [
            { role: 'user', content: 'weather in Paris?' },
            { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: '{"tempC":18}' },
          ],
        })
        .expect(200);
    });

    it('rejects response_format combined with tools with 400 VALIDATION_ERROR', async () => {
      const { apiKey, model } = await setupTeamWithOpenAiModel();
      const res = await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          response_format: { type: 'json_object' },
          tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects response_format combined with tool_choice with 400 VALIDATION_ERROR', async () => {
      const { apiKey, model } = await setupTeamWithOpenAiModel();
      const res = await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          response_format: { type: 'json_object' },
          tool_choice: 'auto',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('tools passthrough — openai', () => {
    it('forwards tools to the provider and surfaces returned tool_calls', async () => {
      const { apiKey, model } = await setupTeamWithOpenAiModel();
      mockFetchOnce({
        id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
      const res = await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ model, messages: [{ role: 'user', content: 'weather?' }], tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }], tool_choice: 'auto' })
        .expect(200);
      // provider received the tools
      const sent = lastProviderRequestBody();
      expect(sent.tools).toHaveLength(1);
      expect(sent.tool_choice).toBe('auto');
      // response surfaces the tool call
      expect(res.body.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
      expect(res.body.choices[0].finish_reason).toBe('tool_calls');
    });

    it('round-trips tool_calls / tool_call_id on the way in, even through the variables-render path', async () => {
      const { apiKey, model } = await setupTeamWithOpenAiModel();
      mockFetchOnce(CANNED_OPENAI);
      await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          model,
          messages: [
            { role: 'user', content: 'weather in {{ city }}?' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: '{"tempC":18}' },
          ],
          variables: { city: 'Paris' },
        })
        .expect(200);
      const sent = lastProviderRequestBody();
      const sentMessages = sent.messages as Record<string, unknown>[];
      // user content still gets templated...
      expect(sentMessages[0]).toMatchObject({ role: 'user', content: 'weather in Paris?' });
      // ...while the assistant tool_calls and tool role/tool_call_id survive untouched.
      expect(sentMessages[1]).toMatchObject({
        role: 'assistant',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
      });
      expect(sentMessages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: '{"tempC":18}' });
    });

    it("tool_choice 'none' still forwards tool declarations to OpenAI unchanged (unlike anthropic/gemini)", async () => {
      const { apiKey, model } = await setupTeamWithOpenAiModel();
      mockFetchOnce(CANNED_OPENAI);
      await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          model,
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
          tool_choice: 'none',
        })
        .expect(200);
      const sent = lastProviderRequestBody();
      // OpenAI's own native tool_choice: 'none' semantics keep tool declarations
      // visible to the model while instructing it not to call one — this adapter
      // is a pure passthrough, so both fields must still be present.
      expect(sent.tools).toHaveLength(1);
      expect(sent.tool_choice).toBe('none');
    });
  });

  describe('tools passthrough — anthropic', () => {
    it('maps tools to input_schema and tool_use blocks back to tool_calls', async () => {
      const { apiKey, model } = await setupTeamWithAnthropicModel();
      mockFetchOnce({
        id: 'msg_1', model: 'claude-x',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 3 },
      });
      const res = await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ model, messages: [{ role: 'user', content: 'weather?' }], tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }] })
        .expect(200);
      const sent = lastProviderRequestBody();
      expect(sent.tools).toEqual([{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }]);
      expect(res.body.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
      expect(JSON.parse(res.body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ city: 'Paris' });
      expect(res.body.choices[0].finish_reason).toBe('tool_calls');
    });

    it('maps a tool-role follow-up message to a tool_result block', async () => {
      const { apiKey, model } = await setupTeamWithAnthropicModel();
      mockFetchOnce({ id: 'msg_2', model: 'claude-x', content: [{ type: 'text', text: '18C' }], stop_reason: 'end_turn', usage: { input_tokens: 6, output_tokens: 2 } });
      await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ model, messages: [
          { role: 'user', content: 'weather?' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
          { role: 'tool', tool_call_id: 'toolu_1', content: '{"tempC":18}' },
        ] })
        .expect(200);
      const sent = lastProviderRequestBody() as { messages: { role: string; content: unknown }[] };
      const toolResultMsg = sent.messages.find((m) => Array.isArray(m.content) && (m.content as { type: string }[]).some((b) => b.type === 'tool_result'));
      expect(toolResultMsg).toBeDefined();
    });

    it("translates tool_choice 'auto' to { type: 'auto' }", async () => {
      const { apiKey, model } = await setupTeamWithAnthropicModel();
      mockFetchOnce(CANNED_ANTHROPIC);
      await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          model,
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
          tool_choice: 'auto',
        })
        .expect(200);
      const sent = lastProviderRequestBody();
      expect(sent.tool_choice).toEqual({ type: 'auto' });
      expect(sent.tools).toHaveLength(1);
    });

    it("translates tool_choice 'required' to { type: 'any' }", async () => {
      const { apiKey, model } = await setupTeamWithAnthropicModel();
      mockFetchOnce(CANNED_ANTHROPIC);
      await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          model,
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
          tool_choice: 'required',
        })
        .expect(200);
      const sent = lastProviderRequestBody();
      expect(sent.tool_choice).toEqual({ type: 'any' });
    });

    it("translates a forced-function tool_choice to { type: 'tool', name }", async () => {
      const { apiKey, model } = await setupTeamWithAnthropicModel();
      mockFetchOnce(CANNED_ANTHROPIC);
      await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          model,
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
          tool_choice: { type: 'function', function: { name: 'get_weather' } },
        })
        .expect(200);
      const sent = lastProviderRequestBody();
      expect(sent.tool_choice).toEqual({ type: 'tool', name: 'get_weather' });
    });

    it("tool_choice 'none' omits both tools and tool_choice from the outgoing Anthropic request", async () => {
      const { apiKey, model } = await setupTeamWithAnthropicModel();
      mockFetchOnce(CANNED_ANTHROPIC);
      await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          model,
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
          tool_choice: 'none',
        })
        .expect(200);
      const sent = lastProviderRequestBody();
      expect(sent.tool_choice).toBeUndefined();
      expect(sent.tools).toBeUndefined();
    });
  });

  describe('tools passthrough — gemini', () => {
    it('maps tools to functionDeclarations and functionCall parts to tool_calls', async () => {
      const { apiKey, model } = await setupTeamWithGeminiModel();
      mockFetchOnce({
        candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
      });
      const res = await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ model, messages: [{ role: 'user', content: 'weather?' }], tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }] })
        .expect(200);
      const sent = lastProviderRequestBody() as { tools?: { functionDeclarations: unknown[] }[] };
      expect(sent.tools?.[0].functionDeclarations).toHaveLength(1);
      expect(res.body.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
      expect(JSON.parse(res.body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ city: 'Paris' });
      expect(res.body.choices[0].finish_reason).toBe('tool_calls');
    });

    it('maps a tool-role follow-up message to a functionResponse part keyed by tool_call_id (the function name)', async () => {
      const { apiKey, model } = await setupTeamWithGeminiModel();
      mockFetchOnce({
        candidates: [{ content: { role: 'model', parts: [{ text: '18C' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2, totalTokenCount: 8 },
      });
      await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          model,
          messages: [
            { role: 'user', content: 'weather?' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'get_weather', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
            { role: 'tool', tool_call_id: 'get_weather', content: '{"tempC":18}' },
          ],
        })
        .expect(200);
      const sent = lastProviderRequestBody() as { contents: { role: string; parts: Record<string, unknown>[] }[] };
      const responseMsg = sent.contents.find((c) => c.parts.some((p) => 'functionResponse' in p));
      expect(responseMsg).toBeDefined();
      expect(responseMsg?.parts[0]).toEqual({ functionResponse: { name: 'get_weather', response: { tempC: 18 } } });
    });

    it("translates tool_choice 'auto' to functionCallingConfig.mode 'AUTO'", async () => {
      const { apiKey, model } = await setupTeamWithGeminiModel();
      mockFetchOnce(CANNED_GEMINI);
      await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          model,
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
          tool_choice: 'auto',
        })
        .expect(200);
      const sent = lastProviderRequestBody();
      expect(sent.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
      expect(sent.tools).toBeDefined();
    });

    it("translates tool_choice 'required' to functionCallingConfig.mode 'ANY'", async () => {
      const { apiKey, model } = await setupTeamWithGeminiModel();
      mockFetchOnce(CANNED_GEMINI);
      await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          model,
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
          tool_choice: 'required',
        })
        .expect(200);
      const sent = lastProviderRequestBody();
      expect(sent.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });
    });

    it("translates a forced-function tool_choice to mode 'ANY' + allowedFunctionNames", async () => {
      const { apiKey, model } = await setupTeamWithGeminiModel();
      mockFetchOnce(CANNED_GEMINI);
      await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          model,
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
          tool_choice: { type: 'function', function: { name: 'get_weather' } },
        })
        .expect(200);
      const sent = lastProviderRequestBody();
      expect(sent.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } });
    });

    it("tool_choice 'none' omits both tools and toolConfig from the outgoing Gemini request", async () => {
      const { apiKey, model } = await setupTeamWithGeminiModel();
      mockFetchOnce(CANNED_GEMINI);
      await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({
          model,
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
          tool_choice: 'none',
        })
        .expect(200);
      const sent = lastProviderRequestBody();
      expect(sent.toolConfig).toBeUndefined();
      expect(sent.tools).toBeUndefined();
    });
  });
});

describe('tool_refs resolution', () => {
  it('resolves a catalog tool_ref into an OpenAI tool and forwards it', async () => {
    const { apiKey, model } = await setupTeamWithOpenAiModel();
    // create a catalog tool + version (production alias auto-created)
    const t = await request(app).post('/api/v1/tools').set('Authorization', `Bearer ${apiKey}`).send({ name: 'get_weather', description: 'w' }).expect(201);
    await request(app).post(`/api/v1/tools/${t.body.id}/versions`).set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: { type: 'object', properties: { city: { type: 'string' } } }, executor: { type: 'client' } }).expect(201);
    mockFetchOnce(CANNED_OPENAI);
    await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${apiKey}`)
      .send({ model, messages: [{ role: 'user', content: 'weather?' }], tool_refs: [{ name: 'get_weather' }] }).expect(200);
    const sent = lastProviderRequestBody() as { tools?: { function: { name: string; parameters: unknown } }[] };
    expect(sent.tools?.[0].function.name).toBe('get_weather');
    expect(sent.tools?.[0].function.parameters).toEqual({ type: 'object', properties: { city: { type: 'string' } } });
  });

  it('merges a non-colliding inline tool with a resolved tool_ref (both forwarded)', async () => {
    const { apiKey, model } = await setupTeamWithOpenAiModel();
    const t = await request(app).post('/api/v1/tools').set('Authorization', `Bearer ${apiKey}`).send({ name: 'get_weather', description: 'w' }).expect(201);
    await request(app).post(`/api/v1/tools/${t.body.id}/versions`).set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: { type: 'object', properties: { city: { type: 'string' } } }, executor: { type: 'client' } }).expect(201);
    mockFetchOnce(CANNED_OPENAI);
    await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${apiKey}`)
      .send({
        model,
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ type: 'function', function: { name: 'calc' } }],
        tool_refs: [{ name: 'get_weather' }],
      })
      .expect(200);
    const sent = lastProviderRequestBody() as { tools?: { function: { name: string } }[] };
    expect(sent.tools).toHaveLength(2);
    expect(sent.tools?.map((tool) => tool.function.name).sort()).toEqual(['calc', 'get_weather']);
  });

  it('400s when an inline tool and a tool_ref share a name', async () => {
    const { apiKey, model } = await setupTeamWithOpenAiModel();
    const t = await request(app).post('/api/v1/tools').set('Authorization', `Bearer ${apiKey}`).send({ name: 'dup' }).expect(201);
    await request(app).post(`/api/v1/tools/${t.body.id}/versions`).set('Authorization', `Bearer ${apiKey}`).send({ parametersSchema: { type: 'object' }, executor: { type: 'client' } }).expect(201);
    const res = await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${apiKey}`)
      .send({ model, messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'dup' } }], tool_refs: [{ name: 'dup' }] }).expect(400);
    expect(res.body.error).toBeDefined();
  });

  it('404s (or 400) when a tool_ref names a missing tool', async () => {
    const { apiKey, model } = await setupTeamWithOpenAiModel();
    await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${apiKey}`)
      .send({ model, messages: [{ role: 'user', content: 'x' }], tool_refs: [{ name: 'nope' }] }).expect(400);
  });
});

describe('stored-prompt auto-attaches tools', () => {
  it("forwards a stored prompt version's attached tools to the provider", async () => {
    const { apiKey, model, agent } = await setupTeamWithOpenAiModel();
    const t = await request(app).post('/api/v1/tools').set('Authorization', `Bearer ${apiKey}`).send({ name: 'get_weather' }).expect(201);
    await request(app).post(`/api/v1/tools/${t.body.id}/versions`).set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: { type: 'object' }, executor: { type: 'client' } }).expect(201);
    const p = await agent.post('/api/v1/prompts').send({ name: `wx_${Date.now()}` }).expect(201);
    await request(app).post(`/api/v1/prompts/${p.body.id}/versions`).set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'hi {{ name }}' }], tools: [{ toolId: t.body.id }] }).expect(201);
    mockFetchOnce(CANNED_OPENAI);
    await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${apiKey}`)
      .send({ model, prompt: { name: p.body.name, alias: 'production', variables: { name: 'Al' } } }).expect(200);
    const sent = lastProviderRequestBody() as { tools?: { function: { name: string } }[] };
    expect(sent.tools?.[0].function.name).toBe('get_weather');
  });

  it('an inline tool of the same name wins over the auto-attached prompt tool (no collision error, no duplicate)', async () => {
    const { apiKey, model, agent } = await setupTeamWithOpenAiModel();
    const t = await request(app).post('/api/v1/tools').set('Authorization', `Bearer ${apiKey}`).send({ name: 'get_weather' }).expect(201);
    await request(app).post(`/api/v1/tools/${t.body.id}/versions`).set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: { type: 'object' }, executor: { type: 'client' } }).expect(201);
    const p = await agent.post('/api/v1/prompts').send({ name: `wx_${Date.now()}` }).expect(201);
    await request(app).post(`/api/v1/prompts/${p.body.id}/versions`).set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'hi {{ name }}' }], tools: [{ toolId: t.body.id }] }).expect(201);
    mockFetchOnce(CANNED_OPENAI);
    await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${apiKey}`)
      .send({
        model,
        prompt: { name: p.body.name, alias: 'production', variables: { name: 'Al' } },
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'inline override', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
      })
      .expect(200);
    const sent = lastProviderRequestBody() as { tools?: { function: { name: string; description?: string } }[] };
    expect(sent.tools).toHaveLength(1);
    expect(sent.tools?.[0].function.description).toBe('inline override');
  });
});

describe('response_format + tools guard runs AFTER tool merging (post-merge, not just Zod)', () => {
  // Regression test: the Zod `superRefine` on ChatCompletionRequestSchema only
  // sees the RAW request body — it cannot see a stored prompt's auto-attached
  // tools, since those are merged onto `req.tools` by GatewayService AFTER Zod
  // validation runs. A request shaped `{ prompt: {...}, response_format: {...} }`
  // where the prompt has a tool attached must still 400, even though neither
  // `tools` nor `tool_choice` nor `tool_refs` appears anywhere in the raw body.
  it("400s when a stored prompt's auto-attached tool collides with response_format", async () => {
    const { apiKey, model, agent } = await setupTeamWithOpenAiModel();
    const t = await request(app).post('/api/v1/tools').set('Authorization', `Bearer ${apiKey}`).send({ name: 'get_weather' }).expect(201);
    await request(app).post(`/api/v1/tools/${t.body.id}/versions`).set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: { type: 'object' }, executor: { type: 'client' } }).expect(201);
    const p = await agent.post('/api/v1/prompts').send({ name: `wxrf_${Date.now()}` }).expect(201);
    await request(app).post(`/api/v1/prompts/${p.body.id}/versions`).set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'hi {{ name }}' }], tools: [{ toolId: t.body.id }] }).expect(201);
    const res = await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${apiKey}`)
      .send({
        model,
        prompt: { name: p.body.name, alias: 'production', variables: { name: 'Al' } },
        response_format: { type: 'json_object' },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400s when tool_refs resolves a tool alongside response_format', async () => {
    const { apiKey, model } = await setupTeamWithOpenAiModel();
    const t = await request(app).post('/api/v1/tools').set('Authorization', `Bearer ${apiKey}`).send({ name: 'get_weather2' }).expect(201);
    await request(app).post(`/api/v1/tools/${t.body.id}/versions`).set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: { type: 'object' }, executor: { type: 'client' } }).expect(201);
    const res = await request(app).post('/api/v1/gateway/chat/completions').set('Authorization', `Bearer ${apiKey}`)
      .send({
        model,
        messages: [{ role: 'user', content: 'weather?' }],
        tool_refs: [{ name: 'get_weather2' }],
        response_format: { type: 'json_object' },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('response_format end-to-end (Task 5)', () => {
  it('OpenAI: response_format is passed straight through and the response content is valid JSON', async () => {
    const { apiKey, model } = await setupTeamWithOpenAiModel();
    mockFetchOnce({
      ...CANNED_OPENAI,
      choices: [{ index: 0, message: { role: 'assistant', content: '{"answer":"hi"}' }, finish_reason: 'stop' }],
    });

    const res = await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        model,
        messages: [{ role: 'user', content: 'Reply with JSON.' }],
        response_format: { type: 'json_object' },
      })
      .expect(200);

    const sent = lastProviderRequestBody();
    expect(sent.response_format).toEqual({ type: 'json_object' });
    expect(() => JSON.parse(res.body.choices[0].message.content)).not.toThrow();
    expect(JSON.parse(res.body.choices[0].message.content)).toEqual({ answer: 'hi' });
  });

  it('Gemini: response_format translates to generationConfig.responseMimeType and the response content is valid JSON', async () => {
    const { apiKey, model } = await setupTeamWithGeminiModel();
    mockFetchOnce({
      candidates: [
        { content: { parts: [{ text: '{"answer":"hi"}' }], role: 'model' }, finishReason: 'STOP', index: 0 },
      ],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
    });

    const res = await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        model,
        messages: [{ role: 'user', content: 'Reply with JSON.' }],
        response_format: { type: 'json_object' },
      })
      .expect(200);

    const sent = lastProviderRequestBody() as { generationConfig?: { responseMimeType?: string } };
    expect(sent.generationConfig?.responseMimeType).toBe('application/json');
    expect(() => JSON.parse(res.body.choices[0].message.content)).not.toThrow();
    expect(JSON.parse(res.body.choices[0].message.content)).toEqual({ answer: 'hi' });
  });

  it('Anthropic: response_format translates to a forced tool call, invisible to the caller (plain JSON content, finish_reason stop)', async () => {
    const { apiKey, model } = await setupTeamWithAnthropicModel();
    mockFetchOnce({
      id: 'msg_rf',
      model: 'claude-x',
      content: [{ type: 'tool_use', id: 'toolu_rf', name: 'structured_output', input: { answer: 'hi' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 4 },
    });

    const res = await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        model,
        messages: [{ role: 'user', content: 'Reply with JSON.' }],
        response_format: { type: 'json_object' },
      })
      .expect(200);

    const sent = lastProviderRequestBody() as { tools?: { name: string }[]; tool_choice?: { type: string; name: string } };
    expect(sent.tools).toEqual([
      expect.objectContaining({ name: 'structured_output', input_schema: { type: 'object' } }),
    ]);
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'structured_output' });

    // Invisible to the caller: plain JSON content, no tool_calls, finish_reason 'stop'.
    expect(res.body.choices[0].message.tool_calls).toBeUndefined();
    expect(res.body.choices[0].finish_reason).toBe('stop');
    expect(() => JSON.parse(res.body.choices[0].message.content)).not.toThrow();
    expect(JSON.parse(res.body.choices[0].message.content)).toEqual({ answer: 'hi' });
  });
});

// ── Live provider tests (skipped unless the key env is set) ──────────────────
// The model is env-overridable so accounts whose catalog differs from the static
// registry (e.g. no `claude-3-5-sonnet-latest`) can point the live test at a model
// they actually have; the default stays the registry model for standard accounts.
const openaiLive = process.env.OPENAI_TEST_KEY ? it : it.skip;
const anthropicLive = process.env.ANTHROPIC_TEST_KEY ? it : it.skip;
const geminiLive = process.env.GEMINI_TEST_KEY ? it : it.skip;
const OPENAI_LIVE_MODEL = process.env.OPENAI_TEST_MODEL ?? 'gpt-4o-mini';
const ANTHROPIC_LIVE_MODEL = process.env.ANTHROPIC_TEST_MODEL ?? 'claude-3-5-sonnet-latest';
const GEMINI_LIVE_MODEL = process.env.GEMINI_TEST_MODEL ?? 'gemini-1.5-flash';

describe('POST /api/v1/gateway/chat/completions (live)', () => {
  openaiLive('makes a real OpenAI call and records non-zero tokens + computed cost', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent, 'openai', process.env.OPENAI_TEST_KEY!);
    await registerModel(agent, credId, OPENAI_LIVE_MODEL);

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: OPENAI_LIVE_MODEL, messages: [{ role: 'user', content: 'Say hi in one word.' }], max_tokens: 5 })
      .expect(200);

    expect(res.body.choices[0].message.content).toBeTruthy();
    const rows = await prisma.gatewayRequest.findMany({ where: { teamId } });
    expect(rows[0]?.promptTokens).toBeGreaterThan(0);
    expect(Number(rows[0]?.costUsd)).toBeGreaterThan(0);
  });

  anthropicLive('makes a real Anthropic call and normalizes the response', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent, 'anthropic', process.env.ANTHROPIC_TEST_KEY!);
    await registerModel(agent, credId, ANTHROPIC_LIVE_MODEL);

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: ANTHROPIC_LIVE_MODEL, messages: [{ role: 'user', content: 'Say hi in one word.' }], max_tokens: 16 })
      .expect(200);

    expect(res.body.choices[0].message.content).toBeTruthy();
    const rows = await prisma.gatewayRequest.findMany({ where: { teamId } });
    expect(rows[0]?.completionTokens).toBeGreaterThan(0);
  });

  geminiLive('makes a real Gemini call and normalizes the response', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await createConnection(agent, 'gemini', process.env.GEMINI_TEST_KEY!);
    await registerModel(agent, credId, GEMINI_LIVE_MODEL);

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: GEMINI_LIVE_MODEL, messages: [{ role: 'user', content: 'Say hi in one word.' }], max_tokens: 16 })
      .expect(200);

    expect(res.body.choices[0].message.content).toBeTruthy();
    expect(res.headers['x-gateway-provider']).toBe('gemini');
    const rows = await prisma.gatewayRequest.findMany({ where: { teamId } });
    expect(rows[0]?.provider).toBe('gemini');
    expect(rows[0]?.promptTokens).toBeGreaterThan(0);
  });
});
