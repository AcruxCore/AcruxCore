import request from 'supertest';
import http, { createServer } from 'http';
import { randomUUID } from 'node:crypto';
import { acruxcore } from '../../src/client';
import { acrux } from '../../src/tools';
import prisma from '../../../../apps/api/src/shared/db/client';
import { signupTestUserWithApiKey } from '../../../../apps/api/src/test-utils/auth';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../../../apps/api/src/tools/execute/safe-fetch';
import type { TraceSpan } from '../../src/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require('../../../../apps/api/app');

const app = createApp();

/**
 * Gateway-vs-BYO comparison suite (design §4). Boots the real `apps/api` Express app
 * in-process against a real Postgres test database — the same bootstrap pattern as
 * `sdk.integration.test.ts` — and drives it with a single shared `acruxcore` client for
 * the whole file, so every describe block below hits the same team/user/model.
 *
 * **This file is NOT part of `npm test`.** It is opt-in via `npm run test:live`, because
 * every scenario below marked `describeLive` makes real, billed calls to an external
 * OpenAI-compatible provider. `package.json`'s `test:integration` explicitly ignores this
 * path so a fresh clone (and CI without the secret) keeps a green, free, offline
 * `npm test` — the Python suite gates the same way via `pytest.skip` in its `conftest.py`.
 *
 * The BYO arm of every test below calls that real endpoint via
 * `provider: { baseUrl: process.env.ACRUXCORE_TEST_PROVIDER_BASE_URL, apiKey: ... }` and
 * therefore needs those two env vars (plus `ACRUXCORE_TEST_MODEL`) set — `jest.setup.ts`
 * loads them from the repo-root `.env` via `dotenv.config()`. With any of the three
 * missing, `live` is false: the credential-dependent describes are skipped (reported as
 * skipped, never failed) and only the mock-server 429 test — which needs no credential —
 * runs. The gateway arm of each comparison needs a real provider connection + registered
 * model server-side for the test team, so `beforeAll` registers one
 * (`POST /gateway/connections` then `POST /gateway/models`) using the SAME provider
 * credential and model id the BYO arm already uses — the gateway's `openai_compatible`
 * provider kind just points its own request at `config.base_url` instead of the caller's
 * own process making the call, so both arms end up hitting the exact same upstream model.
 * This means both arms are real, live calls: the comparison isolates the gateway hop
 * itself, per design §4.
 */
const live = Boolean(
  process.env.ACRUXCORE_TEST_PROVIDER_BASE_URL &&
  process.env.ACRUXCORE_TEST_PROVIDER_API_KEY &&
  process.env.ACRUXCORE_TEST_MODEL,
);
const describeLive = live ? describe : describe.skip;

const MODEL = process.env.ACRUXCORE_TEST_MODEL ?? 'gpt-4o-mini';
/** The BYO provider config every live scenario passes as `provider`. */
const providerConfig = {
  baseUrl: process.env.ACRUXCORE_TEST_PROVIDER_BASE_URL!,
  apiKey: process.env.ACRUXCORE_TEST_PROVIDER_API_KEY!,
};

let hub: acruxcore;
let server: http.Server;
/** Upstream the `http`-executor catalog tool actually calls (loopback, in-process). */
let toolBackend: http.Server;
/** Name of the catalog tool whose executor is `http` — used via `toolRefs`, never declared. */
let httpToolName: string;

/** Flattens `GET /traces/:id`'s span tree so a test can assert over every span at once. */
function flattenSpans(spans: TraceSpan[]): TraceSpan[] {
  return spans.flatMap((s) => [s, ...flattenSpans(s.children ?? [])]);
}

beforeAll(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE span_payloads, spans, traces, team_trace_settings, gateway_requests, provider_connections, prompt_tool_bindings, tool_aliases, tool_versions, tools, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;

  const { apiKey, cookie } = await signupTestUserWithApiKey(app);

  // Fixture for the trace read-back suite's `hub.renderPrompt('greeting', 'production', ...)`.
  const promptRes = await request(app)
    .post('/api/v1/prompts')
    .set('Cookie', cookie)
    .send({ name: 'greeting' })
    .expect(201);
  await request(app)
    .post(`/api/v1/prompts/${promptRes.body.id}/versions`)
    .set('Cookie', cookie)
    .send({ messages: [{ role: 'user', content: 'Say hello to {{ name }}.' }] })
    .expect(201);
  await request(app)
    .post(`/api/v1/prompts/${promptRes.body.id}/aliases/production/promote`)
    .set('Cookie', cookie)
    .send({ version_number: 1 })
    .expect(200);

  // A catalog tool with an `http` executor — the platform runs it, mid-loop, via
  // `POST /tools/:id/execute`. That is the one tool route whose span is written
  // SERVER-side, which is what makes it the only route able to expose the trace
  // create/parent ordering bug the final review found (I5).
  toolBackend = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ tempC: 18, echoed: raw ? JSON.parse(raw) : null }));
    });
  });
  await new Promise<void>((resolve) => toolBackend.listen(0, '127.0.0.1', resolve));
  const toolPort = (toolBackend.address() as { port: number }).port;
  // In-process test-only seam: the executor's URL is loopback, which production refuses.
  allowLoopbackForTests();

  httpToolName = 'get_weather_http';
  const toolRes = await request(app)
    .post('/api/v1/tools')
    .set('Cookie', cookie)
    .send({ name: httpToolName, description: 'Looks up the current temperature for a city.' })
    .expect(201);
  await request(app)
    .post(`/api/v1/tools/${toolRes.body.id}/versions`)
    .set('Cookie', cookie)
    .send({
      parametersSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      executor: {
        type: 'http',
        url: `http://127.0.0.1:${toolPort}/weather`,
        method: 'POST',
        responseTransform: 'function transform(input) { return input.body; }',
      },
    })
    .expect(201);

  if (live) {
    // Register a real gateway connection + model backed by the SAME credential the BYO
    // arm calls directly, under the SAME public name every test already passes as
    // `model` (ACRUXCORE_TEST_MODEL) — so `hub.chat({ model, messages })` with no
    // `provider` now routes through our gateway to this connection instead of failing
    // with MODEL_NOT_REGISTERED. Pricing fields are omitted deliberately: OpenRouter's
    // `openai/gpt-4o-mini` id isn't in the static pricing registry `resolvePrices`
    // consults, so they resolve to null rather than failing validation.
    const connRes = await request(app)
      .post('/api/v1/gateway/connections')
      .set('Cookie', cookie)
      .send({
        provider: 'openai_compatible',
        label: 'byo-comparison test',
        apiKey: providerConfig.apiKey,
        config: { base_url: providerConfig.baseUrl },
      })
      .expect(201);

    await request(app)
      .post('/api/v1/gateway/models')
      .set('Cookie', cookie)
      .send({ publicName: MODEL, upstreamModel: MODEL, credentialId: connRes.body.id })
      .expect(201);
  }

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  // Unlike sdk.integration.test.ts's per-test clients, this shared hub deliberately
  // keeps the SDK's default maxRetries (1) rather than 0 — the 429-retry suite below
  // needs a real retry to happen, and the default's single 500ms retry costs nothing
  // for the other suites since real calls succeed on the first attempt.
  hub = new acruxcore({ apiKey, baseUrl: `http://localhost:${port}/api/v1` });
});

afterAll(async () => {
  resetSsrfAllowlist();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => toolBackend.close(() => resolve()));
  await prisma.$disconnect();
});

describeLive('gateway vs BYO — latency (design §4.1)', () => {
  const N = 5;

  it('reports p50 latency for both paths on the same prompt + model', async () => {
    const messages = [{ role: 'user' as const, content: 'Say the word "test".' }];

    const gatewayTimes: number[] = [];
    for (let i = 0; i < N; i++) {
      const start = Date.now();
      await hub.gateway.chat({ model: MODEL, messages, trace: false });
      gatewayTimes.push(Date.now() - start);
    }

    const byoTimes: number[] = [];
    for (let i = 0; i < N; i++) {
      const start = Date.now();
      await hub.gateway.chat({ model: MODEL, messages, provider: providerConfig, trace: false });
      byoTimes.push(Date.now() - start);
    }

    const p50 = (arr: number[]) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    // eslint-disable-next-line no-console
    console.log(`[latency] gateway p50=${p50(gatewayTimes)}ms byo p50=${p50(byoTimes)}ms`);
    // Not a strict assertion of "faster" (network variance, single sample) — this
    // test's job is to PRODUCE the number for a human to read, per design §4.1.
    expect(byoTimes.length).toBe(N);
    expect(gatewayTimes.length).toBe(N);
  }, 30_000); // 10 live network calls (5 gateway + 5 BYO) comfortably exceed Jest's 5s default.
});

describeLive('gateway vs BYO — tool-calling (design §4.2)', () => {
  const weatherTool = acrux.tool(
    { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
    ({ city }: { city: string }) => ({ city, tempC: 18 }),
  );

  it.each([
    ['gateway', undefined],
    ['BYO', providerConfig],
  ])('%s: calls the declared tool and produces a final answer', async (_label, provider) => {
    const result = await hub.gateway.runToolLoop({
      model: MODEL,
      messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
      tools: [weatherTool],
      ...(provider ? { provider } : {}),
    });
    expect(result.stoppedAtLimit).toBe(false);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.messages.some((m) => m.role === 'tool')).toBe(true);
  });

  // The `toolRefs` arm the design asked for (§4.2) and the one the final review found
  // missing (I4) — it is also the only arm that exercises `inlinedSchemas.push(...)`
  // from a resolver-fed ref rather than a declared tool, and the only one whose tool
  // runs SERVER-side mid-loop (I5).
  it('BYO + a toolRefs tool with an http executor: trace is named runToolLoop and the tool span nests under the round llm span', async () => {
    const result = await hub.gateway.runToolLoop({
      model: MODEL,
      messages: [{ role: 'user', content: `What is the weather in Paris? Use the ${httpToolName} tool.` }],
      toolRefs: [{ name: httpToolName }],
      provider: providerConfig,
    });

    expect(result.stoppedAtLimit).toBe(false);
    expect(result.messages.some((m) => m.role === 'tool')).toBe(true);
    expect(result.traceId).toBeTruthy();

    // Auto-reports are backgrounded — wait for the queue before reading them back.
    await hub.gateway.flush();
    const trace = await hub.traces.get(result.traceId!);

    // I5 (a): the trace was created by the SDK's per-round llm span report, so it carries
    // the loop's name. Before the fix, `tools/execute` created it first and named it
    // `tool:<toolName>` — and a later ingest POST merges tags/metadata/sessionId, never
    // the name, so the wrong name stuck permanently.
    expect(trace.trace.name).toBe('runToolLoop');

    const all = flattenSpans(trace.spans);
    const llmSpans = all.filter((s) => s.kind === 'llm');
    const toolSpans = all.filter((s) => s.kind === 'tool');
    expect(llmSpans.length).toBeGreaterThanOrEqual(1);
    expect(toolSpans.length).toBeGreaterThanOrEqual(1);
    // The platform wrote this span (executorType http), not the SDK.
    expect(toolSpans[0].attributes).toMatchObject({ executorType: 'http' });

    // I5 (b): the tool span is NESTED, not orphaned at the trace root.
    expect(trace.spans.some((s) => s.kind === 'tool')).toBe(false);
    expect(toolSpans[0].parentSpanId).toBe(llmSpans[0].spanId);

    // I2: a BYO round's llm span records the real duration of the completion, because
    // startTime is captured before the provider call rather than after it returned.
    // Every BYO tool-loop round used to report latency_ms: 0.
    for (const llm of llmSpans) {
      expect(llm.latencyMs).not.toBeNull();
      expect(llm.latencyMs!).toBeGreaterThan(0);
    }
  }, 60_000); // Two live rounds plus a server-side tool execution.
});

describeLive('gateway vs BYO — result correctness (design §4.3)', () => {
  it('temperature-0 call: finishReason and token counts match between paths', async () => {
    const messages = [{ role: 'user' as const, content: 'Reply with exactly the word: pineapple' }];

    const gatewayResult = await hub.gateway.chat({ model: MODEL, messages, temperature: 0, trace: false });
    const byoResult = await hub.gateway.chat({ model: MODEL, messages, temperature: 0, trace: false, provider: providerConfig });

    expect(byoResult.finishReason).toBe(gatewayResult.finishReason);
    // Allow a small tolerance — different request paths may tokenize a trailing
    // newline differently; the design calls for "consistent," not byte-identical.
    expect(Math.abs((byoResult.usage?.totalTokens ?? 0) - (gatewayResult.usage?.totalTokens ?? 0))).toBeLessThanOrEqual(2);
  });
});

describeLive('BYO trace read-back', () => {
  it('GET /traces/:id shows one trace with one llm span (promptVersionId set, costUsd null)', async () => {
    const rendered = await hub.prompts.render('greeting', 'production', { name: 'Alice' });
    const result = await hub.gateway.chat({
      model: MODEL,
      messages: rendered.messages,
      promptVersionId: rendered.versionId ?? undefined,
      provider: providerConfig,
    });

    await hub.gateway.flush();
    const trace = await hub.traces.get(result.gateway.traceId!);
    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0].kind).toBe('llm');
    expect(trace.spans[0].costUsd).toBeNull();
    if (rendered.versionId) expect(trace.spans[0].promptVersionId).toBe(rendered.versionId);
  });

  it('two chained chat() calls with trace: { traceId } land in one trace as sibling spans', async () => {
    const first = await hub.gateway.chat({ model: MODEL, messages: [{ role: 'user', content: 'a' }], provider: providerConfig });
    await hub.gateway.chat({ model: MODEL, messages: [{ role: 'user', content: 'b' }], provider: providerConfig, trace: { traceId: first.gateway.traceId! } });

    await hub.gateway.flush();
    const trace = await hub.traces.get(first.gateway.traceId!);
    expect(trace.spans).toHaveLength(2);
    expect(trace.spans.every((s) => s.parentSpanId === null)).toBe(true);
  });

  // Regression guard for the final review's I1. This one is only catchable through the
  // REAL ingest endpoint: the collision is a Postgres unique-constraint violation on
  // spans (traceId, spanRef), which the SDK's best-effort catch then swallows — so the
  // documented opt-in silently recorded nothing while 500ing the API on every call.
  it('gateway path with trace: true records a SECOND span instead of colliding with the gateway own span', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await hub.gateway.chat({
        model: MODEL,
        messages: [{ role: 'user', content: 'Say the word "test".' }],
        trace: true,
      });

      expect(result.gateway.traceId).toBeTruthy();

      // The report is backgrounded, so both the warning check and the read-back have to
      // wait for the queue — a failure would otherwise be warned about after the assert.
      await hub.gateway.flush();

      // The best-effort trace report must not have failed.
      const traceWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('trace report failed'));
      expect(traceWarnings).toEqual([]);

      const trace = await hub.traces.get(result.gateway.traceId!);
      const llmSpans = flattenSpans(trace.spans).filter((s) => s.kind === 'llm');
      // The gateway's own span for this completion + the client-reported one.
      expect(llmSpans).toHaveLength(2);
      // The client's span uses its own id, never the gateway's persisted spanRef.
      expect(new Set(llmSpans.map((s) => s.spanId)).size).toBe(2);
      expect(llmSpans.some((s) => s.spanId === result.gateway.spanRef)).toBe(true);
      expect(llmSpans.some((s) => s.spanId.startsWith('chat-'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  // First REAL SSE stream in this suite (design §4.1/§4's coverage list, final review I4):
  // keep-alive comment frames, `\r\n` line endings and where the usage frame lands
  // relative to `[DONE]` are all provider behaviour a mocked unit test cannot validate.
  it('BYO streaming chat() accumulates a real SSE stream and reports one llm span with usage', async () => {
    const traceId = randomUUID();
    const stream = await hub.gateway.stream({
      model: MODEL,
      messages: [{ role: 'user', content: 'Count from one to five, words only.' }],
      provider: providerConfig,
      // The streaming path reports its span after the stream ends and returns no handle
      // to it, so the test supplies the trace id it will read back.
      trace: { traceId },
    });

    let content = '';
    let finishReason: string | null = null;
    let chunks = 0;
    for await (const chunk of stream) {
      chunks++;
      content += chunk.delta.content ?? '';
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }

    expect(chunks).toBeGreaterThan(1);
    expect(content.trim().length).toBeGreaterThan(0);
    expect(finishReason).toBe('stop');

    await hub.gateway.flush();
    const trace = await hub.traces.get(traceId);
    expect(trace.spans).toHaveLength(1);
    const span = trace.spans[0];
    expect(span.kind).toBe('llm');
    expect(span.model).toBe(MODEL);
    expect(span.provider).toBe(new URL(providerConfig.baseUrl).hostname);
    // stream_options.include_usage actually produced real numbers on the final frame.
    expect(span.totalTokens).not.toBeNull();
    expect(span.totalTokens!).toBeGreaterThan(0);
    expect(span.promptTokens!).toBeGreaterThan(0);
    expect(span.completionTokens!).toBeGreaterThan(0);
    expect(span.latencyMs!).toBeGreaterThan(0);
    // M3: finishReason is surfaced on the span rather than accumulated and dropped.
    expect(span.attributes).toMatchObject({ finishReason: 'stop' });
  }, 30_000);
});

describe('BYO 429 retry (design §4 additional coverage)', () => {
  it('retries once on 429 and succeeds', async () => {
    let requestCount = 0;
    const retryServer = createServer((req, res) => {
      requestCount++;
      if (requestCount === 1) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'rate limited' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'c1', model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }));
    });
    await new Promise<void>((resolve) => retryServer.listen(0, resolve));
    const { port } = retryServer.address() as { port: number };

    const result = await hub.gateway.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { baseUrl: `http://localhost:${port}`, apiKey: 'k' },
      trace: false,
    });

    expect(requestCount).toBe(2);
    expect(result.content).toBe('ok');
    await new Promise<void>((resolve) => retryServer.close(() => resolve()));
  });
});
