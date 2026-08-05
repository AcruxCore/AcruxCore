import request from 'supertest';
import http, { createServer } from 'http';
import { acruxcore } from '../../src/client';
import { acrux } from '../../src/tools';
import prisma from '../../../../apps/api/src/shared/db/client';
import { signupTestUserWithApiKey } from '../../../../apps/api/src/test-utils/auth';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../../../apps/api/src/tools/execute/safe-fetch';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require('../../../../apps/api/app');

const app = createApp();

/**
 * Signs up a real user and mints a personal API key.
 *
 * Delegates to apps/api's own `signupTestUserWithApiKey` rather than posting to an auth
 * endpoint directly. These suites used to hard-code `/api/v1/auth/signup`, which stopped
 * existing when auth moved to Better Auth — every test 404'd at setup. Sharing the
 * fixture means the next auth change fixes these suites for free.
 */
async function setupUserAndKey(): Promise<{ apiKey: string }> {
  const ctx = await signupTestUserWithApiKey(app);
  return { apiKey: ctx.apiKey };
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
    span_payloads, spans, traces, team_trace_settings,
    prompt_aliases, prompt_versions, audit_log, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('acruxcore SDK — trace()', () => {
  it('posts a trace, returns { traceId }, and a second call with that id appends', async () => {
    const { apiKey } = await setupUserAndKey();

    const http = await import('http');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const hub = new acruxcore({ apiKey, baseUrl: `http://localhost:${port}/api/v1`, maxRetries: 0 });

    // Mint a new trace with an llm span + a tool child.
    const { traceId } = await hub.traces.ingest({
      name: 'agent-run',
      spans: [
        {
          spanId: 's1', name: 'gpt-4o-mini', kind: 'llm',
          startTime: '2026-07-04T10:00:00.000Z', endTime: '2026-07-04T10:00:01.000Z',
          model: 'gpt-4o-mini', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        },
        {
          spanId: 's2', parentSpanId: 's1', name: 'search', kind: 'tool',
          startTime: '2026-07-04T10:00:00.200Z', endTime: '2026-07-04T10:00:00.400Z',
        },
      ],
    });

    expect(typeof traceId).toBe('string');

    // Append a third span under the same trace id.
    const second = await hub.traces.ingest({
      traceId,
      spans: [
        { spanId: 's3', parentSpanId: 's1', name: 'finalize', kind: 'chain', startTime: '2026-07-04T10:00:00.500Z' },
      ],
    });
    expect(second.traceId).toBe(traceId);

    const spans = await prisma.span.findMany({ where: { traceId } });
    expect(spans).toHaveLength(3);
    const traces = await prisma.trace.findMany({});
    expect(traces).toHaveLength(1);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('a trace-level capturePayloads: true writes a span_payloads row even with the team default off', async () => {
    const { apiKey } = await setupUserAndKey();

    const http = await import('http');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const hub = new acruxcore({ apiKey, baseUrl: `http://localhost:${port}/api/v1`, maxRetries: 0 });

    // Team's payload-capture default is off (no team_trace_settings row exists yet
    // for a freshly signed-up team), so this exercises the per-trace override.
    const { traceId } = await hub.traces.ingest({
      name: 'agent-run-with-capture',
      capturePayloads: true,
      spans: [
        {
          spanId: 's1', name: 'gpt-4o-mini', kind: 'llm',
          startTime: '2026-07-04T10:00:00.000Z', endTime: '2026-07-04T10:00:01.000Z',
          model: 'gpt-4o-mini',
          input: [{ role: 'user', content: 'Say hi to Al' }],
          output: { role: 'assistant', content: 'Hi Al!' },
        },
      ],
    });

    const span = await prisma.span.findFirstOrThrow({ where: { traceId } });
    const payload = await prisma.spanPayload.findUnique({ where: { spanId: span.id } });
    expect(payload).not.toBeNull();
    expect(payload!.input).toEqual([{ role: 'user', content: 'Say hi to Al' }]);
    expect(payload!.output).toEqual({ role: 'assistant', content: 'Hi Al!' });

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

/**
 * Background trace reporting, against the real API and the real Postgres.
 *
 * The model provider is a loopback stub — these tests are about where spans end up and
 * when, not about a real completion, and a stub keeps them free and offline. The traces
 * API is the genuine one, since that is the thing under test.
 */
describe('background trace reporting (real API)', () => {
  /** Everything started for one test, torn down in `afterEach`. */
  const opened: http.Server[] = [];

  /** Starts an http server on a free loopback port and returns its port. */
  async function start(server: http.Server): Promise<number> {
    opened.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    return (server.address() as { port: number }).port;
  }

  /** One OpenAI-shaped completion; passing `toolCall` makes the model ask for a tool. */
  function completion(content: string | null, toolCall?: { name: string; args: string }) {
    return {
      id: 'c1',
      model: 'stub-model',
      choices: [
        {
          index: 0,
          finish_reason: toolCall ? 'tool_calls' : 'stop',
          message: {
            role: 'assistant',
            content,
            ...(toolCall
              ? { tool_calls: [{ id: 'tc1', type: 'function', function: { name: toolCall.name, arguments: toolCall.args } }] }
              : {}),
          },
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
    };
  }

  /** A provider stub that answers each request from `responses`, in order. */
  function providerStub(responses: unknown[]): http.Server {
    let call = 0;
    return createServer((_req, res) => {
      const body = responses[Math.min(call++, responses.length - 1)];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  }

  /**
   * Forwards every request to the real app on `targetPort`, holding `POST …/traces` for
   * `delayMs` first.
   *
   * Loopback Postgres answers a trace write in about 17 ms, so "the span has not landed
   * yet" would be a race against the machine. Slowing only that one route makes it a fact.
   */
  function delayingProxy(targetPort: number, delayMs: number): http.Server {
    return createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const forward = () => {
          const upstream = http.request(
            { host: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: req.headers },
            (up) => {
              res.writeHead(up.statusCode ?? 502, up.headers);
              up.pipe(res);
            },
          );
          upstream.on('error', () => {
            res.writeHead(502);
            res.end();
          });
          upstream.end(Buffer.concat(chunks));
        };
        const isTraceWrite = req.method === 'POST' && Boolean(req.url?.endsWith('/traces'));
        if (isTraceWrite) setTimeout(forward, delayMs);
        else forward();
      });
    });
  }

  afterEach(async () => {
    await Promise.all(opened.map((s) => new Promise<void>((r) => s.close(() => r()))));
    opened.length = 0;
    resetSsrfAllowlist();
  });

  it('a chat() span is absent when the call returns and present after flush()', async () => {
    const { apiKey } = await setupUserAndKey();
    const apiPort = await start(createServer(app));
    const proxyPort = await start(delayingProxy(apiPort, 400));
    const providerPort = await start(providerStub([completion('pong')]));

    const hub = new acruxcore({ apiKey, baseUrl: `http://127.0.0.1:${proxyPort}/api/v1`, maxRetries: 0 });

    const started = Date.now();
    const result = await hub.gateway.chat({
      model: 'stub-model',
      messages: [{ role: 'user', content: 'ping' }],
      provider: { baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'p' },
    });
    const elapsed = Date.now() - started;
    const traceId = result.gateway.traceId!;
    expect(traceId).toBeTruthy();

    // The bug this fixes: the call used to include the whole trace round-trip.
    expect(elapsed).toBeLessThan(200);
    expect(await prisma.span.count({ where: { traceId } })).toBe(0);

    await hub.gateway.flush();

    const spans = await prisma.span.findMany({ where: { traceId } });
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('llm');
    expect(spans[0].model).toBe('stub-model');
    expect(spans[0].totalTokens).toBe(8);

    await hub.gateway.close();
  });

  it("a client-side tool loop nests its tool span under that round's llm span", async () => {
    const { apiKey } = await setupUserAndKey();
    const apiPort = await start(createServer(app));
    const providerPort = await start(
      providerStub([completion(null, { name: 'add', args: '{"a":2,"b":3}' }), completion('5')]),
    );

    const hub = new acruxcore({ apiKey, baseUrl: `http://localhost:${apiPort}/api/v1`, maxRetries: 0 });
    const add = acrux.tool(
      { name: 'add', description: 'Adds two numbers.', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
      ({ a, b }: { a: number; b: number }) => String(a + b),
    );

    const loop = await hub.gateway.runToolLoop({
      model: 'stub-model',
      messages: [{ role: 'user', content: 'what is 2 + 3?' }],
      tools: [add],
      provider: { baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'p' },
    });
    expect(loop.content).toBe('5');

    await hub.gateway.flush();

    const spans = await prisma.span.findMany({ where: { traceId: loop.traceId! }, orderBy: { startedAt: 'asc' } });
    const llmSpans = spans.filter((s) => s.kind === 'llm');
    const toolSpan = spans.find((s) => s.kind === 'tool');
    expect(llmSpans).toHaveLength(2);
    expect(toolSpan).toBeDefined();
    // The tool span's parent is a real llm span on the same trace — the ordering the
    // serial drain loop exists to preserve.
    expect(llmSpans.map((s) => s.spanRef)).toContain(toolSpan!.parentSpanRef);

    await hub.gateway.close();
  });

  it("an http-executor loop keeps the loop's trace name and nests the server-run tool span", async () => {
    const { apiKey, cookie } = await signupTestUserWithApiKey(app);
    const apiPort = await start(createServer(app));
    const providerPort = await start(
      providerStub([completion(null, { name: 'get_weather_http', args: '{"city":"Berlin"}' }), completion('18°C')]),
    );

    // Upstream the platform's http executor actually calls, mid-loop.
    const toolPort = await start(
      createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ tempC: 18 }));
      }),
    );
    // In-process test-only seam: the executor's URL is loopback, which production refuses.
    allowLoopbackForTests();

    const toolRes = await request(app)
      .post('/api/v1/tools')
      .set('Cookie', cookie)
      .send({ name: 'get_weather_http', description: 'Looks up the current temperature for a city.' })
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

    const hub = new acruxcore({ apiKey, baseUrl: `http://localhost:${apiPort}/api/v1`, maxRetries: 0 });
    const loop = await hub.gateway.runToolLoop({
      model: 'stub-model',
      messages: [{ role: 'user', content: 'weather in Berlin?' }],
      toolRefs: [{ name: 'get_weather_http' }],
      provider: { baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'p' },
      trace: { name: 'weather-loop' },
    });
    expect(loop.messages.some((m) => m.role === 'tool')).toBe(true);

    await hub.gateway.flush();

    // The whole point of the one surviving await: without it the platform would have
    // created this trace itself, named `tool:get_weather_http`, with a null parent on
    // the tool span — and a later ingest never renames a trace.
    const trace = await prisma.trace.findUniqueOrThrow({ where: { id: loop.traceId! } });
    expect(trace.name).toBe('weather-loop');

    const spans = await prisma.span.findMany({ where: { traceId: loop.traceId! } });
    const toolSpan = spans.find((s) => s.kind === 'tool');
    expect(toolSpan).toBeDefined();
    // The platform wrote this span, not the SDK.
    expect(toolSpan!.attributes).toMatchObject({ executorType: 'http' });
    expect(toolSpan!.parentSpanRef).not.toBeNull();
    expect(spans.filter((s) => s.kind === 'llm').map((s) => s.spanRef)).toContain(toolSpan!.parentSpanRef);

    await hub.gateway.close();
  });

  it('a script that exits without close() still delivers its trace', async () => {
    const received: unknown[] = [];
    // A stub stands in for the platform here rather than the real app: the assertion is
    // about the exiting child process having sent anything at all, and a stub makes
    // "did it arrive" observable without a second database round-trip.
    const acruxPort = await start(
      createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          received.push(JSON.parse(raw));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ accepted: 1, traceIds: ['33333333-3333-4333-8333-333333333333'] }));
        });
      }),
    );
    const providerPort = await start(providerStub([completion('pong')]));

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [require.resolve('./exit-flush.fixture.mjs')],
      {
        env: {
          ...process.env,
          FIXTURE_API_KEY: 'k',
          FIXTURE_BASE_URL: `http://127.0.0.1:${acruxPort}/api/v1`,
          FIXTURE_PROVIDER_URL: `http://127.0.0.1:${providerPort}`,
        },
      },
    );

    expect(stdout).toBe('done');
    expect(received).toHaveLength(1); // beforeExit flushed it
  }, 30_000);
});
