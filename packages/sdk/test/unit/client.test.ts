import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod/v4';
import { toJSONSchema } from 'zod/v4';
import { getCache, _resetCacheForTesting } from '../../src/cache';
import { fetchWithRetry } from '../../src/fetch';
import { acruxcore } from '../../src/client';
import { acruxcoreError } from '../../src/error';

// A zod v4 schema reused by the three zod-responseFormat tests below. Mirrors the shape the
// dict-path tests use, so the two paths are directly comparable.
const weatherSchema = z.object({
  temp_c: z.number().describe('Temperature in Celsius'),
  city: z.string().describe('City name'),
});
const weatherJsonSchema = (() => {
  const { $schema: _ignored, ...rest } = toJSONSchema(weatherSchema) as Record<string, unknown>;
  return rest;
})();

// ── Cache module tests ──────────────────────────────────────────────────────

describe('getCache', () => {
  beforeEach(() => { _resetCacheForTesting(); });

  it('returns the same instance on repeated calls', () => {
    const a = getCache(100);
    const b = getCache(100);
    expect(a).toBe(b);
  });

  it('initialises with maxSize from the first call', () => {
    const cache = getCache(42);
    expect(cache.max).toBe(42);
  });

  it('ignores maxSize on subsequent calls', () => {
    getCache(42);
    const cache = getCache(999);
    expect(cache.max).toBe(42);
  });
});

// ── fetchWithRetry tests ────────────────────────────────────────────────────

describe('fetchWithRetry', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns response on first success', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const res = await fetchWithRetry('http://example.com', {}, 1, 0);
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on network error and succeeds on second attempt', async () => {
    const mock = global.fetch as ReturnType<typeof vi.fn>;
    mock
      .mockRejectedValueOnce(new Error('Network failure'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const res = await fetchWithRetry('http://example.com', {}, 1, 0);
    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 4xx', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response('', { status: 400 }));
    const res = await fetchWithRetry('http://example.com', {}, 2, 0);
    expect(res.status).toBe(400);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 like a 5xx', async () => {
    const mock = global.fetch as ReturnType<typeof vi.fn>;
    mock
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const res = await fetchWithRetry('http://example.com', {}, 1, 0);
    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('returns the last 429 response after exhausting retries', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response('', { status: 429 }));
    const res = await fetchWithRetry('http://example.com', {}, 1, 0);
    expect(res.status).toBe(429);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting all retries on persistent network error', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error('Connection refused'));
    await expect(fetchWithRetry('http://example.com', {}, 1, 0))
      .rejects.toThrow('Connection refused');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

// ── acruxcore constructor tests ────────────────────────────────────────────

describe('acruxcore constructor', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetCacheForTesting();
    delete process.env.ACRUXCORE_API_KEY;
    delete process.env.ACRUXCORE_BASE_URL;
  });

  afterEach(() => {
    process.env.ACRUXCORE_API_KEY = originalEnv.ACRUXCORE_API_KEY;
    process.env.ACRUXCORE_BASE_URL = originalEnv.ACRUXCORE_BASE_URL;
  });

  it('throws MISSING_API_KEY when no apiKey in args or env', () => {
    expect(() => new acruxcore({ baseUrl: 'http://localhost:3000' }))
      .toThrow(acruxcoreError);
    try {
      new acruxcore({ baseUrl: 'http://localhost:3000' });
    } catch (err) {
      expect((err as acruxcoreError).code).toBe('MISSING_API_KEY');
    }
  });

  it('throws MISSING_BASE_URL when no baseUrl in args or env', () => {
    expect(() => new acruxcore({ apiKey: 'key123' }))
      .toThrow(acruxcoreError);
    try {
      new acruxcore({ apiKey: 'key123' });
    } catch (err) {
      expect((err as acruxcoreError).code).toBe('MISSING_BASE_URL');
    }
  });

  it('reads apiKey and baseUrl from env vars', () => {
    process.env.ACRUXCORE_API_KEY = 'env-key';
    process.env.ACRUXCORE_BASE_URL = 'http://localhost:3000';
    expect(() => new acruxcore()).not.toThrow();
  });

  it('strips trailing slash from baseUrl', () => {
    expect(() => new acruxcore({ apiKey: 'k', baseUrl: 'http://localhost:3000/' }))
      .not.toThrow();
  });
});

// ── acruxcore renderPrompt tests ───────────────────────────────────────────

describe('acruxcore.renderPrompt', () => {
  let hub: acruxcore;

  beforeEach(() => {
    _resetCacheForTesting();
    vi.stubGlobal('fetch', vi.fn());
    hub = new acruxcore({ apiKey: 'test-key', baseUrl: 'http://localhost:3000' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetCacheForTesting();
  });

  const makeOkResponse = (messages = [{ role: 'user' as const, content: 'Hello' }]) =>
    new Response(JSON.stringify({ messages }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('returns messages array on success', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeOkResponse());
    const result = await hub.renderPrompt('my-prompt', 'production', { name: 'Alice' });
    expect(result.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('renders a prompt and returns messages + tools', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }], tools: [{ type: 'function', function: { name: 'get_weather' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await hub.renderPrompt('greeting', 'production', {});
    expect(result.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    expect(result.tools).toEqual([{ type: 'function', function: { name: 'get_weather' } }]);
  });

  it('defaults tools to [] when the response omits them', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await hub.renderPrompt('greeting', 'production', {});
    expect(result.tools).toEqual([]);
  });

  it('returns the version bound model, and null when the response omits it', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }], model: 'gpt-4o-mini' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect((await hub.renderPrompt('bound-model-prompt', 'production')).model).toBe('gpt-4o-mini');
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect((await hub.renderPrompt('no-model-prompt', 'production')).model).toBeNull();
  });

  it('returns versionId and versionNumber from the render response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
        versionId: 'v-123',
        versionNumber: 4,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const result = await hub.renderPrompt('greeting', 'production', {});
    expect(result.versionId).toBe('v-123');
    expect(result.versionNumber).toBe(4);
  });

  it('defaults versionId/versionNumber to null when the response omits them', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const result = await hub.renderPrompt('greeting', 'production', {});
    expect(result.versionId).toBeNull();
    expect(result.versionNumber).toBeNull();
  });

  it('calls POST /prompts/:name/:alias/render with correct headers and body', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeOkResponse());
    await hub.renderPrompt('my-prompt', 'production', { name: 'Alice' });

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/prompts/my-prompt/production/render');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
    expect(JSON.parse(init.body as string)).toEqual({ variables: { name: 'Alice' } });
  });

  it('defaults variables to {} when not provided', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeOkResponse());
    await hub.renderPrompt('my-prompt', 'production');
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ variables: {} });
  });

  it('caches the result — repeating the same variables does not hit fetch', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeOkResponse());
    await hub.renderPrompt('my-prompt', 'production', { name: 'Alice' });
    await hub.renderPrompt('my-prompt', 'production', { name: 'Alice' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('renders again for different variables instead of serving the first render', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeOkResponse([{ role: 'user', content: 'Hello Alice' }]))
      .mockResolvedValueOnce(makeOkResponse([{ role: 'user', content: 'Hello Bob' }]));

    const alice = await hub.renderPrompt('my-prompt', 'production', { name: 'Alice' });
    const bob = await hub.renderPrompt('my-prompt', 'production', { name: 'Bob' });

    expect(alice.messages[0].content).toBe('Hello Alice');
    expect(bob.messages[0].content).toBe('Hello Bob');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('treats the same variables in a different key order as one cache entry', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeOkResponse());
    await hub.renderPrompt('my-prompt', 'production', { name: 'Alice', city: 'Lahore' });
    await hub.renderPrompt('my-prompt', 'production', { city: 'Lahore', name: 'Alice' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('cacheTtl of 0 disables the cache — every call hits the API', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeOkResponse([{ role: 'user', content: 'v1' }]))
      .mockResolvedValueOnce(makeOkResponse([{ role: 'user', content: 'v2' }]));

    const uncached = new acruxcore({
      apiKey: 'no-cache-key',
      baseUrl: 'http://localhost:3000',
      cacheTtl: 0,
    });

    const first = await uncached.renderPrompt('my-prompt', 'production');
    const second = await uncached.renderPrompt('my-prompt', 'production');

    expect(first.messages[0].content).toBe('v1');
    expect(second.messages[0].content).toBe('v2');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('cacheTtl of 0 writes nothing to the cache', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeOkResponse());
    const uncached = new acruxcore({
      apiKey: 'no-write-key',
      baseUrl: 'http://localhost:3000',
      cacheTtl: 0,
    });

    await uncached.renderPrompt('my-prompt', 'production');

    expect(getCache(500).size).toBe(0);
  });

  it('cache key is scoped to apiKey — different keys get different entries', async () => {
    _resetCacheForTesting();
    const hub2 = new acruxcore({ apiKey: 'other-key', baseUrl: 'http://localhost:3000' });
    // Return a fresh Response on each call — a single Response can only be read once
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve(makeOkResponse()),
    );

    await hub.renderPrompt('my-prompt', 'production');
    await hub2.renderPrompt('my-prompt', 'production');

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('throws MISSING_VARIABLES on 400 with missing array', async () => {
    const body = { error: { code: 'MISSING_VARIABLES', message: 'Missing: name', missing: ['name'] } };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status: 400 }),
    );
    await expect(hub.renderPrompt('my-prompt', 'production', {}))
      .rejects.toThrow(acruxcoreError);
    try {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(JSON.stringify(body), { status: 400 }),
      );
      await hub.renderPrompt('my-prompt', 'production', {});
    } catch (err) {
      const e = err as acruxcoreError;
      expect(e.code).toBe('MISSING_VARIABLES');
      expect(e.statusCode).toBe(400);
    }
  });

  it('throws API_ERROR on 401', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('{"error":"Unauthorized"}', { status: 401 }),
    );
    try {
      await hub.renderPrompt('my-prompt', 'production');
    } catch (err) {
      const e = err as acruxcoreError;
      expect(e.code).toBe('API_ERROR');
      expect(e.statusCode).toBe(401);
    }
  });

  it('throws API_ERROR on 404', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('{"error":"Not found"}', { status: 404 }),
    );
    try {
      await hub.renderPrompt('my-prompt', 'production');
    } catch (err) {
      const e = err as acruxcoreError;
      expect(e.code).toBe('API_ERROR');
      expect(e.statusCode).toBe(404);
    }
  });

  it('throws NETWORK_ERROR on cold cache with API unreachable after retries', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));
    const hubNoRetry = new acruxcore({ apiKey: 'k', baseUrl: 'http://localhost:3000', maxRetries: 0, retryInterval: 0 });
    try {
      await hubNoRetry.renderPrompt('my-prompt', 'production');
    } catch (err) {
      expect((err as acruxcoreError).code).toBe('NETWORK_ERROR');
    }
  });

  it('serves stale cache and logs warning when API is unreachable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeOkResponse());
    // Use maxRetries:0 and retryInterval:0 so background refresh fails immediately
    const hub3 = new acruxcore({
      apiKey: 'stale-key',
      baseUrl: 'http://localhost:3000',
      cacheTtl: 1,
      maxRetries: 0,
      retryInterval: 0,
    });
    await hub3.renderPrompt('my-prompt', 'production');

    // Wait for cacheTtl to expire
    await new Promise((r) => setTimeout(r, 5));

    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));

    const result = await hub3.renderPrompt('my-prompt', 'production');
    expect(result.messages).toEqual([{ role: 'user', content: 'Hello' }]);

    // Drain the microtask queue so the background refresh .catch() fires
    await new Promise((r) => setTimeout(r, 20));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Background refresh failed'),
      expect.any(String),
    );

    warnSpy.mockRestore();
  });
});

// ── acruxcore.runToolLoop tests ────────────────────────────────────────────

describe('runToolLoop', () => {
  let hub: acruxcore;

  beforeEach(() => {
    _resetCacheForTesting();
    vi.stubGlobal('fetch', vi.fn());
    hub = new acruxcore({ apiKey: 'test-key', baseUrl: 'http://localhost:3000' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetCacheForTesting();
  });

  const traceAcceptedResponse = () =>
    new Response(JSON.stringify({ accepted: 1, traceIds: ['trace-1'] }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('drives the loop, threads the gateway trace into one trace, and reports only tool spans', async () => {
    // The gateway records each `llm` round-trip itself and returns the trace id +
    // its span ref via x-gateway-* headers. The SDK adopts that trace and reports
    // ONLY the tool span, parented under the gateway's llm span.
    const first = new Response(JSON.stringify({
      id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-gateway-trace-id': 'gw-trace', 'x-gateway-span-id': 'gw-span-0' } });
    const second = new Response(JSON.stringify({
      id: 'c2', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'It is 18°C in Paris.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-gateway-trace-id': 'gw-trace', 'x-gateway-span-id': 'gw-span-1' } });
    vi.mocked(fetch).mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(traceAcceptedResponse());

    const dispatched: { name: string; args: unknown }[] = [];
    const result = await hub.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'weather in Paris?' }],
      toolDefs: [{ type: 'function', function: { name: 'get_weather' } }],
      dispatch: (name, args) => { dispatched.push({ name, args }); return { tempC: 18 }; },
    });
    expect(dispatched).toEqual([{ name: 'get_weather', args: { city: 'Paris' } }]);
    expect(result.content).toBe('It is 18°C in Paris.');
    expect(result.iterations).toBe(2);
    expect(result.stoppedAtLimit).toBe(false);
    // transcript: user, assistant(tool_calls), tool(result), assistant(final)
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    // The trace id comes from the gateway, not the tool-span POST response.
    expect(result.traceId).toBe('gw-trace');

    // First completion threads the trace NAME but no id yet (none known).
    const firstInit = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    const firstHeaders = firstInit.headers as Record<string, string>;
    expect(firstHeaders['x-trace-name']).toBe('runToolLoop');
    expect(firstHeaders['x-trace-id']).toBeUndefined();
    // Second completion re-uses the gateway trace id so both llm spans co-locate.
    const secondHeaders = (vi.mocked(fetch).mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(secondHeaders['x-trace-id']).toBe('gw-trace');

    // Third fetch is the tool-span report: ONLY the tool span, on the gateway's
    // trace, parented under the round's llm span ref.
    const [traceUrl, traceInit] = vi.mocked(fetch).mock.calls[2] as [string, RequestInit];
    expect(traceUrl).toBe('http://localhost:3000/traces');
    const traceBody = JSON.parse(traceInit.body as string) as { traces: { traceId: string; spans: { kind: string; parentSpanId?: string; input?: unknown; output?: unknown }[] }[] };
    expect(traceBody.traces[0].traceId).toBe('gw-trace');
    expect(traceBody.traces[0].spans.map((s) => s.kind)).toEqual(['tool']);
    expect(traceBody.traces[0].spans[0].parentSpanId).toBe('gw-span-0');
    // The tool span carries its args + result as the payload (so it doesn't read
    // "Payload not captured" in the UI when capture is on).
    expect(traceBody.traces[0].spans[0].input).toEqual({ city: 'Paris' });
    expect(traceBody.traces[0].spans[0].output).toEqual({ tempC: 18 });
  });

  it('shapes a typed answer when given both tools and responseFormat — two phases, one trace', async () => {
    // Tools + responseFormat cannot share one gateway request, so the SDK gathers (tools,
    // no format) then shapes (format, no tools) on the same trace. Gather rounds must NOT
    // carry response_format; only the final shaping round does.
    const hdr = (span: string) => ({ 'content-type': 'application/json', 'x-gateway-trace-id': 'gw-trace', 'x-gateway-span-id': span });
    const completions = [
      new Response(JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: hdr('gw-span-0') }),
      new Response(JSON.stringify({ id: 'c2', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'It is 18C in Paris.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }), { status: 200, headers: hdr('gw-span-1') }),
      new Response(JSON.stringify({ id: 'c3', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: '{"tempC":18,"city":"Paris"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } }), { status: 200, headers: hdr('gw-span-2') }),
    ];
    let cIdx = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/traces')) return traceAcceptedResponse();
      return completions[cIdx++];
    });

    const result = await hub.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'weather in Paris?' }],
      toolDefs: [{ type: 'function', function: { name: 'get_weather' } }],
      dispatch: () => ({ tempC: 18 }),
      responseFormat: { type: 'json_schema', json_schema: { name: 'weather', schema: { type: 'object' }, strict: true } },
    });

    // The returned content is the SHAPING round's JSON, not the gather round's prose.
    expect(result.content).toBe('{"tempC":18,"city":"Paris"}');
    expect(result.iterations).toBe(2);

    // Exactly three completion calls (2 gather + 1 shape); /traces span reports are ignored.
    const completionCalls = vi.mocked(fetch).mock.calls
      .filter(([u]) => (typeof u === 'string' ? u : (u as Request).url).includes('/chat/completions')) as [string, RequestInit][];
    expect(completionCalls).toHaveLength(3);
    const bodyOf = (c: [string, RequestInit]) => JSON.parse(c[1].body as string) as Record<string, unknown>;
    const gatherBodies = [bodyOf(completionCalls[0]), bodyOf(completionCalls[1])];
    const shapeBody = bodyOf(completionCalls[2]);
    // Gather rounds carry tools and NO response_format.
    for (const b of gatherBodies) {
      expect(b['tools']).toBeDefined();
      expect(b['response_format']).toBeUndefined();
    }
    // The shaping round carries response_format and NO tools / tool_refs.
    expect(shapeBody['response_format']).toBeDefined();
    expect(shapeBody['tools']).toBeUndefined();
    expect(shapeBody['tool_refs']).toBeUndefined();
    // The shaping round reuses phase 1's trace (seeded), so every round co-locates.
    expect((completionCalls[2][1].headers as Record<string, string>)['x-trace-id']).toBe('gw-trace');
  });

  it('threads x-session-id so the gateway stamps the session when it creates the trace', async () => {
    const done = new Response(JSON.stringify({
      id: 'c', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-gateway-trace-id': 'gw' } });
    vi.mocked(fetch).mockResolvedValueOnce(done);

    await hub.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      dispatch: () => ({}),
      trace: { name: 'run', sessionId: 'sess-1' },
    });

    const headers = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-session-id']).toBe('sess-1');
  });

  it('skips auto-tracing when trace: false', async () => {
    const first = new Response(JSON.stringify({
      id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.mocked(fetch).mockResolvedValueOnce(first);

    const result = await hub.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      dispatch: () => ({}),
      trace: false,
    });
    expect(result.traceId).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('threads responseFormat into the round request body — for a tool-less loop shaping a final answer', async () => {
    // response_format and tools are mutually exclusive on the gateway, so this
    // exercises the valid shape: no tools attached, just a typed final answer.
    const done = new Response(JSON.stringify({
      id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: '{"answer":"ok"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.mocked(fetch).mockResolvedValueOnce(done);

    const schema = { type: 'json_schema' as const, json_schema: { name: 'final_answer', schema: { type: 'object' }, strict: true } };
    const result = await hub.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'summarize' }],
      responseFormat: schema,
      trace: false,
    });

    expect(result.content).toBe('{"answer":"ok"}');
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.response_format).toEqual(schema);
    expect(body.tools).toBeUndefined();
    expect(body.tool_refs).toBeUndefined();
  });

  it('converts a zod responseFormat to json_schema in the request body (chat)', async () => {
    // The { zod, name } form is resolved to the OpenAI-shaped wire dict before the request
    // is built, so the body carries the converted dict, not the zod schema.
    vi.mocked(fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: '{"temp_c":18}' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await hub.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      responseFormat: { zod: weatherSchema, name: 'weather_answer' },
    });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_schema', json_schema: { name: 'weather_answer', schema: weatherJsonSchema, strict: true } },
    });
  });

  it('threads a zod responseFormat into the round body for a tool-less loop shaping a final answer', async () => {
    const done = new Response(JSON.stringify({
      id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: '{"temp_c":18}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.mocked(fetch).mockResolvedValueOnce(done);

    const result = await hub.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'summarize' }],
      responseFormat: { zod: weatherSchema, name: 'weather_answer', strict: false },
      trace: false,
    });

    expect(result.content).toBe('{"temp_c":18}');
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'weather_answer', schema: weatherJsonSchema, strict: false },
    });
    expect(body.tools).toBeUndefined();
    expect(body.tool_refs).toBeUndefined();
  });

  it('shapes a typed answer with a zod responseFormat — two phases, one trace', async () => {
    // Same two-phase split as the dict test, but responseFormat is the { zod, name } form.
    // Gather rounds carry tools and NO response_format; the shaping round carries the
    // CONVERTED response_format dict and no tools.
    const hdr = (span: string) => ({ 'content-type': 'application/json', 'x-gateway-trace-id': 'gw-trace', 'x-gateway-span-id': span });
    const completions = [
      new Response(JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: hdr('gw-span-0') }),
      new Response(JSON.stringify({ id: 'c2', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'It is 18C in Paris.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }), { status: 200, headers: hdr('gw-span-1') }),
      new Response(JSON.stringify({ id: 'c3', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: '{"temp_c":18,"city":"Paris"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } }), { status: 200, headers: hdr('gw-span-2') }),
    ];
    let cIdx = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/traces')) return traceAcceptedResponse();
      return completions[cIdx++];
    });

    const result = await hub.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'weather in Paris?' }],
      toolDefs: [{ type: 'function', function: { name: 'get_weather' } }],
      dispatch: () => ({ tempC: 18 }),
      responseFormat: { zod: weatherSchema, name: 'weather_answer' },
    });

    expect(result.content).toBe('{"temp_c":18,"city":"Paris"}');
    expect(result.iterations).toBe(2);
    const completionCalls = vi.mocked(fetch).mock.calls
      .filter(([u]) => (typeof u === 'string' ? u : (u as Request).url).includes('/chat/completions')) as [string, RequestInit][];
    expect(completionCalls).toHaveLength(3);
    const bodyOf = (c: [string, RequestInit]) => JSON.parse(c[1].body as string) as Record<string, unknown>;
    for (const b of [bodyOf(completionCalls[0]), bodyOf(completionCalls[1])]) {
      expect(b['tools']).toBeDefined();
      expect(b['response_format']).toBeUndefined();
    }
    expect(bodyOf(completionCalls[2])['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'weather_answer', schema: weatherJsonSchema, strict: true },
    });
    expect(bodyOf(completionCalls[2])['tools']).toBeUndefined();
  });

  it('stops at maxIterations and flags it', async () => {
    const calling = () => new Response(JSON.stringify({ id: 'x', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.mocked(fetch).mockImplementation(async (url) => (typeof url === 'string' && url.endsWith('/traces') ? traceAcceptedResponse() : calling()));
    const result = await hub.runToolLoop({ model: 'm', messages: [{ role: 'user', content: 'go' }], toolDefs: [{ type: 'function', function: { name: 'f' } }], dispatch: () => ({}), maxIterations: 3 });
    expect(result.stoppedAtLimit).toBe(true);
    expect(result.iterations).toBe(3);
  });

  it('produces a valid string tool-result content when dispatch returns undefined (a void/side-effect-only tool)', async () => {
    const first = new Response(JSON.stringify({
      id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'log_event', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const second = new Response(JSON.stringify({
      id: 'c2', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'Logged.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.mocked(fetch).mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(traceAcceptedResponse());

    const result = await hub.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'log this' }],
      toolDefs: [{ type: 'function', function: { name: 'log_event' } }],
      dispatch: () => undefined,
    });

    const toolMessage = result.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toBe('null');
    expect(typeof toolMessage?.content).toBe('string');
  });

  it('dispatches multiple tool calls in one turn concurrently, keeping result order', async () => {
    // One assistant turn asking for two tools at once, then a final answer.
    const first = new Response(JSON.stringify({
      id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [
        { id: 't1', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 't2', type: 'function', function: { name: 'b', arguments: '{}' } },
      ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const second = new Response(JSON.stringify({
      id: 'c2', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.mocked(fetch).mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(traceAcceptedResponse());

    // 'a' cannot finish until 'b' has started. If dispatch were sequential
    // (await a, then b), 'a' would wait forever for 'b' — the test would hang.
    // Completing proves the two dispatches overlap.
    let markBStarted: () => void;
    const bStarted = new Promise<void>((res) => { markBStarted = res; });
    const events: string[] = [];

    const result = await hub.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolDefs: [{ type: 'function', function: { name: 'a' } }, { type: 'function', function: { name: 'b' } }],
      dispatch: async (name) => {
        events.push(`start:${name}`);
        if (name === 'b') markBStarted();
        if (name === 'a') await bStarted;
        events.push(`end:${name}`);
        return { tool: name };
      },
    });

    // Both started before either finished → they ran concurrently.
    expect(events.slice(0, 2).sort()).toEqual(['start:a', 'start:b']);
    // Results are appended in call order regardless of which finished first.
    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['t1', 't2']);
    expect(toolMsgs.map((m) => m.content)).toEqual(['{"tool":"a"}', '{"tool":"b"}']);
    expect(result.content).toBe('done');
  });
});

describe('runToolLoop with provider (BYO)', () => {
  let hub: acruxcore;

  beforeEach(() => {
    _resetCacheForTesting();
    vi.stubGlobal('fetch', vi.fn());
    hub = new acruxcore({ apiKey: 'our-key', baseUrl: 'http://localhost:3000' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetCacheForTesting();
  });

  it('calls the provider directly for every iteration, mints one trace across both rounds, and reports llm + tool spans', async () => {
    const first = new Response(JSON.stringify({
      id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const second = new Response(JSON.stringify({
      id: 'c2', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'It is 18°C in Paris.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const traceResp = () => new Response(JSON.stringify({ accepted: 1, traceIds: ['minted-trace'] }), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.mocked(fetch)
      // Deliberately slow, so the round's llm span has a measurable duration to get
      // wrong — an `endTime - startTime` of 0 is exactly the I2 bug.
      .mockImplementationOnce(async () => { await new Promise((r) => setTimeout(r, 30)); return first; })
      .mockResolvedValueOnce(traceResp())
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(traceResp())
      .mockResolvedValueOnce(traceResp());

    const result = await hub.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'weather in Paris?' }],
      toolDefs: [{ type: 'function', function: { name: 'get_weather' } }],
      dispatch: () => ({ tempC: 18 }),
      provider: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'groq-key' },
    });

    expect(result.content).toBe('It is 18°C in Paris.');
    // Each round's llm span is handed to the background queue as soon as that round
    // returns and BEFORE the round's tools are dispatched, so its write is already on
    // the wire by the time a tool could dispatch mid-loop (I5). Nothing is awaited, so
    // how many requests carry those spans is emergent — assert the spans and their
    // order across whichever requests carried them, not a fixed request count.
    await hub.flush();

    const calls = vi.mocked(fetch).mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url).filter((url) => url.endsWith('/chat/completions'))).toHaveLength(2);
    // The provider is called first, and the round's trace write follows it immediately.
    expect(calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(calls[1][0]).toBe('http://localhost:3000/traces');

    type TraceEntry = { traceId: string; name: string; spans: { kind: string; startTime: string; endTime: string }[] };
    const traceEntries = calls
      .filter(([url]) => url === 'http://localhost:3000/traces')
      .flatMap(([, init]) => (JSON.parse(init.body as string) as { traces: TraceEntry[] }).traces);

    // Both rounds' llm spans + the tool span all end up on the ONE minted trace.
    expect(result.traceId).toBeTruthy();
    expect(traceEntries.flatMap((t) => t.spans.map((s) => s.kind))).toEqual(['llm', 'llm', 'tool']);
    // Every write targets the same trace id, and names it, so the trace is created as
    // `runToolLoop` on the first round rather than by whoever writes to it first.
    for (const entry of traceEntries) {
      expect(entry.traceId).toBe(result.traceId);
      expect(entry.name).toBe('runToolLoop');
    }
    // I2: startTime is captured BEFORE the completion call, so a 30ms completion shows
    // up as a ~30ms span rather than the 0ms every BYO round used to report.
    const llmSpan = traceEntries[0].spans[0];
    const spanMs = new Date(llmSpan.endTime).getTime() - new Date(llmSpan.startTime).getTime();
    expect(spanMs).toBeGreaterThanOrEqual(20);
  });

  it('inlines full tool JSON Schema (not tool_refs) when calling a BYO provider', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ toolId: 'tool-1', versionNumber: 1, executorType: 'client', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ accepted: 1, traceIds: ['t1'] }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await hub.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: 'weather?' }],
      toolRefs: [{ name: 'get_weather' }],
      dispatch: () => ({}),
      provider: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k' },
    });

    // Call 0 = tools.resolve (our API), call 1 = the BYO completion.
    const [completionUrl, completionInit] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    expect(completionUrl).toBe('https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse(completionInit.body as string);
    expect(body.tool_refs).toBeUndefined();
    expect(body.tools).toEqual([{
      type: 'function',
      function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
    }]);
  });
});

// ── acruxcore.chat tests ───────────────────────────────────────────────────

describe('acruxcore.chat', () => {
  let hub: acruxcore;

  beforeEach(() => {
    _resetCacheForTesting();
    vi.stubGlobal('fetch', vi.fn());
    hub = new acruxcore({ apiKey: 'test-key', baseUrl: 'http://localhost:3000' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetCacheForTesting();
  });

  it('returns content, message, usage, and gateway metadata on a plain completion', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({
        id: 'chatcmpl-1', model: 'gpt-4o-mini-2024-07-18',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 13, completion_tokens: 2, total_tokens: 15 },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-gateway-request-id': 'req-1',
          'x-gateway-provider': 'openai',
          'x-gateway-model': 'gpt-4o-mini-2024-07-18',
          'x-gateway-cost-usd': '0.00000315',
          'x-gateway-cache': 'miss',
        },
      },
    ));

    const result = await hub.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Say hi' }] });

    expect(result.content).toBe('Hello!');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 13, completionTokens: 2, totalTokens: 15 });
    expect(result.gateway).toEqual({
      requestId: 'req-1', provider: 'openai', model: 'gpt-4o-mini-2024-07-18', costUsd: 0.00000315, cache: 'miss',
      traceId: null, spanRef: null,
    });
  });

  it('passes tool_calls back raw without dispatching them', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({
        id: 'c1', model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const result = await hub.chat({ model: 'm', messages: [{ role: 'user', content: 'weather?' }], tools: [{ type: 'function', function: { name: 'get_weather' } }] });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.message.tool_calls).toEqual([{ id: 't1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }]);
  });

  it('sends tools/toolRefs/toolChoice/temperature/maxTokens in the request body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await hub.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f' } }],
      toolRefs: [{ name: 'weather', alias: 'production' }],
      toolChoice: 'auto',
      temperature: 0.2,
      maxTokens: 50,
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/gateway/chat/completions');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f' } }],
      tool_refs: [{ name: 'weather', alias: 'production' }],
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: 50,
    });
  });

  it('sends responseFormat as response_format in the request body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await hub.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      responseFormat: { type: 'json_schema', json_schema: { name: 'ok', schema: { type: 'object' }, strict: true } },
    });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_schema', json_schema: { name: 'ok', schema: { type: 'object' }, strict: true } },
    });
  });

  it('throws API_ERROR on a non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { code: 'MODEL_NOT_ALLOWED', message: 'nope' } }),
      { status: 403 },
    ));
    await expect(hub.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(acruxcoreError);
  });

  it('streams SSE chunks and stops at [DONE]', async () => {
    const frames = [
      'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"One"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":" two"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const chunks = [];
    for await (const chunk of await hub.chat({ model: 'm', messages: [{ role: 'user', content: 'count' }], stream: true })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0].delta.content).toBe('One');
    expect(chunks[1].delta.content).toBe(' two');
    expect(chunks[2].finishReason).toBe('stop');

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).stream).toBe(true);
  });
});

// ── BYO (provider-direct) completion tests ─────────────────────────────────

describe('acruxcore.chat with provider (BYO)', () => {
  let hub: acruxcore;

  beforeEach(() => {
    _resetCacheForTesting();
    vi.stubGlobal('fetch', vi.fn());
    hub = new acruxcore({ apiKey: 'our-key', baseUrl: 'http://localhost:3000' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetCacheForTesting();
  });

  it('calls the provider baseUrl directly, not our gateway, and never sends provider apiKey to us', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({
        id: 'chatcmpl-byo-1', model: 'llama-3.1-70b',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const result = await hub.chat({
      model: 'llama-3.1-70b',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'groq-secret-key' },
      trace: false,
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer groq-secret-key');
    expect(result.content).toBe('Hi!');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
  });

  it('BYO gateway metadata: provider inferred from baseUrl, costUsd null, traceId/spanRef minted', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({
        id: 'chatcmpl-byo-2', model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const result = await hub.chat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-real' },
      trace: false,
    });

    expect(result.gateway.requestId).toBe('chatcmpl-byo-2');
    // inferProviderName returns the raw hostname (Task 4 correction) — not a
    // shortened "openai" label.
    expect(result.gateway.provider).toBe('api.openai.com');
    expect(result.gateway.costUsd).toBeNull();
    expect(result.gateway.cache).toBeNull();
    expect(typeof result.gateway.traceId).toBe('string');
    expect(typeof result.gateway.spanRef).toBe('string');
  });

  it('client-level provider default is used when no per-call provider is given', async () => {
    const hubWithDefault = new acruxcore({
      apiKey: 'our-key',
      baseUrl: 'http://localhost:3000',
      provider: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'groq-key' },
    });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await hubWithDefault.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], trace: false });
    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  it('per-call provider overrides the client-level default', async () => {
    const hubWithDefault = new acruxcore({
      apiKey: 'our-key',
      baseUrl: 'http://localhost:3000',
      provider: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'groq-key' },
    });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await hubWithDefault.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { baseUrl: 'https://api.together.xyz/v1', apiKey: 'together-key' },
      trace: false,
    });
    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.together.xyz/v1/chat/completions');
  });

  it('throws PROVIDER_ERROR on a non-2xx response from the BYO endpoint', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { message: 'invalid_api_key' } }),
      { status: 401 },
    ));
    await expect(hub.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { baseUrl: 'https://api.openai.com/v1', apiKey: 'bad-key' },
      trace: false,
    })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('auto-reports a trace with one llm span by default for a BYO call', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          id: 'c1', model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: 1, traceIds: ['minted-trace'] }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await hub.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' },
      promptVersionId: 'v-42',
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const [traceUrl, traceInit] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    expect(traceUrl).toBe('http://localhost:3000/traces');
    const traceBody = JSON.parse(traceInit.body as string) as {
      traces: { spans: { kind: string; model: string; provider: string; promptVersionId?: string; input?: unknown; output?: unknown; usage?: unknown }[] }[];
    };
    const span = traceBody.traces[0].spans[0];
    expect(span.kind).toBe('llm');
    expect(span.model).toBe('m');
    // inferProviderName returns the raw hostname (Task 4 correction) — not a
    // shortened "openai" label.
    expect(span.provider).toBe('api.openai.com');
    expect(span.promptVersionId).toBe('v-42');
    expect(span.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  });

  it('BYO: the reported span id IS the freshly-minted result.gateway.spanRef', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: 1, traceIds: ['t1'] }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await hub.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { baseUrl: 'https://api.openai.com/v1', apiKey: 'k' },
    });

    // Nothing is persisted under a BYO spanRef until this very POST, so reusing it keeps
    // the id the caller reads off `result.gateway` identical to the one on the trace.
    const body = JSON.parse((vi.mocked(fetch).mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(body.traces[0].spans[0].spanId).toBe(result.gateway.spanRef);
    expect(body.traces[0].traceId).toBe(result.gateway.traceId);
  });

  it('gateway path with trace: true mints its OWN span id rather than reusing the gateway span the server already stored', async () => {
    // Regression guard for the final review's I1: `x-gateway-span-id` names a span row
    // the gateway ALREADY wrote into `x-gateway-trace-id`. Re-posting that same pair
    // violates spans' unique (traceId, spanRef) constraint, so the API 500s and this
    // method's best-effort catch swallows it — the documented opt-in recorded nothing.
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-gateway-trace-id': 'gw-trace',
            'x-gateway-span-id': 'gw-span-already-stored',
          },
        },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: 1, traceIds: ['gw-trace'] }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await hub.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], trace: true });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[1] as [string, RequestInit])[1].body as string);
    // Same trace (that is the point of opting in) but a DIFFERENT span id.
    expect(body.traces[0].traceId).toBe('gw-trace');
    expect(body.traces[0].spans[0].spanId).not.toBe('gw-span-already-stored');
    expect(body.traces[0].spans[0].spanId).toMatch(/^chat-[0-9a-f-]{36}$/);
  });

  it('skips auto-tracing a BYO call when trace: false', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await hub.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' },
      trace: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('threads trace: { traceId } across two manual chat() calls into one trace', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'first' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: 1, traceIds: ['t1'] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ id: 'c2', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'second' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: 1, traceIds: ['t1'] }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const first = await hub.chat({ model: 'm', messages: [{ role: 'user', content: 'a' }], provider: { baseUrl: 'https://api.openai.com/v1', apiKey: 'k' } });
    await hub.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'b' }],
      provider: { baseUrl: 'https://api.openai.com/v1', apiKey: 'k' },
      trace: { traceId: first.gateway.traceId! },
    });
    // Auto-reports are backgrounded now, so wait for the queue before reading the
    // requests it made.
    await hub.flush();

    // How many requests carried the two spans is emergent — the queue coalesces
    // whatever piles up behind a request already in flight, and two entries sharing a
    // trace id merge into one. So assert over the entries, not over a request index.
    const entries = (vi.mocked(fetch).mock.calls as unknown as [string, RequestInit][])
      .filter(([url]) => url.endsWith('/traces'))
      .flatMap(([, init]) => (JSON.parse(init.body as string) as { traces: { traceId: string; spans: unknown[] }[] }).traces);
    expect(entries.flatMap((t) => t.spans)).toHaveLength(2);
    expect([...new Set(entries.map((t) => t.traceId))]).toEqual([first.gateway.traceId]);
  });

  it('BYO streaming: sends stream_options.include_usage, accumulates content, auto-reports one llm span with usage', async () => {
    const frames = [
      'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"c1","model":"m","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
      'data: [DONE]\n\n',
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: 1, traceIds: ['t1'] }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const chunks: string[] = [];
    for await (const chunk of await hub.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k' },
      stream: true,
    })) {
      if (chunk.delta.content) chunks.push(chunk.delta.content);
    }
    expect(chunks.join('')).toBe('Hello');

    const [reqUrl, reqInit] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(reqUrl).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(JSON.parse(reqInit.body as string).stream_options).toEqual({ include_usage: true });

    // Give the best-effort post-stream trace report a tick to fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).toHaveBeenCalledTimes(2);
    const traceBody = JSON.parse((vi.mocked(fetch).mock.calls[1] as [string, RequestInit])[1].body as string);
    const span = traceBody.traces[0].spans[0];
    expect(span.kind).toBe('llm');
    expect(span.output).toEqual({ role: 'assistant', content: 'Hello' });
    expect(span.usage).toEqual({ promptTokens: 4, completionTokens: 2, totalTokens: 6 });
  });

  it('BYO streaming: reassembles a data: frame split mid-frame across two chunk-boundary reads', async () => {
    // One SSE frame, deliberately cut in the middle of its JSON payload — the
    // decoder must buffer the first half and only parse once "\n\n" arrives.
    const full = 'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(full);
    const splitAt = 40;
    expect(splitAt).toBeLessThan(bytes.length); // sanity: the split really lands inside the frame
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, splitAt));
        controller.enqueue(bytes.slice(splitAt));
        controller.close();
      },
    });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const chunks: string[] = [];
    for await (const chunk of await hub.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k' },
      stream: true,
      trace: false,
    })) {
      if (chunk.delta.content) chunks.push(chunk.delta.content);
    }
    expect(chunks.join('')).toBe('Hello');
  });

  it('BYO streaming: accumulates tool_calls fragments split across chunks into the auto-reported trace output', async () => {
    // Real providers stream a tool call's id/name in the first delta and its
    // arguments in fragments across subsequent deltas, all correlated by `index`.
    const frames = [
      'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"NYC\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"id":"c1","model":"m","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
      'data: [DONE]\n\n',
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: 1, traceIds: ['t1'] }), { status: 200, headers: { 'content-type': 'application/json' } }));

    // The raw chunks a caller sees still forward each delta as-is, unmerged.
    const rawToolCallDeltas: unknown[] = [];
    for await (const chunk of await hub.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'weather in NYC' }],
      provider: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k' },
      stream: true,
    })) {
      const delta = chunk.delta as { tool_calls?: unknown[] };
      if (delta.tool_calls) rawToolCallDeltas.push(delta.tool_calls);
    }
    // All three tool_calls-bearing frames are forwarded to the caller unmerged —
    // no accumulation happens on the raw yielded chunk, only in the trace output below.
    expect(rawToolCallDeltas).toHaveLength(3);

    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).toHaveBeenCalledTimes(2);
    const traceBody = JSON.parse((vi.mocked(fetch).mock.calls[1] as [string, RequestInit])[1].body as string);
    const span = traceBody.traces[0].spans[0];
    expect(span.output.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
    ]);
  });

  it('throws MISSING_API_KEY before any network call when provider.apiKey is empty', async () => {
    await expect(hub.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { baseUrl: 'https://api.openai.com/v1', apiKey: '' },
    })).rejects.toMatchObject({ code: 'MISSING_API_KEY' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws MISSING_BASE_URL before any network call when provider.baseUrl is empty', async () => {
    await expect(hub.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { baseUrl: '', apiKey: 'k' },
    })).rejects.toMatchObject({ code: 'MISSING_BASE_URL' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws MISSING_API_KEY before streaming when provider.apiKey is empty', async () => {
    const result = hub.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { baseUrl: 'https://api.openai.com/v1', apiKey: '' },
      stream: true,
    });

    await expect((async () => {
      for await (const _ of await result) {
        // iterate to trigger generator execution
      }
    })()).rejects.toMatchObject({ code: 'MISSING_API_KEY' });

    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── acruxcore feedback + trace read-back tests ────────────────────────────

describe('acruxcore feedback + trace read-back', () => {
  let hub: acruxcore;

  beforeEach(() => {
    _resetCacheForTesting();
    vi.stubGlobal('fetch', vi.fn());
    hub = new acruxcore({ apiKey: 'test-key', baseUrl: 'http://localhost:3000' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetCacheForTesting();
  });

  it('submitFeedback POSTs to /traces/:id/feedback', async () => {
    const row = { id: 'f1', traceId: 't1', spanId: null, rating: 1, label: null, comment: null, source: 'user', createdBy: 'u1', createdAt: 'x', updatedAt: 'x' };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(row), { status: 201, headers: { 'content-type': 'application/json' } }));

    const result = await hub.submitFeedback({ traceId: 't1', rating: 1 });
    expect(result).toEqual(row);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/traces/t1/feedback');
    expect(JSON.parse(init.body as string)).toEqual({ rating: 1 });
  });

  it('updateFeedback PATCHes to /traces/:id/feedback/:feedbackId', async () => {
    const row = { id: 'f1', traceId: 't1', spanId: null, rating: -1, label: null, comment: null, source: 'user', createdBy: 'u1', createdAt: 'x', updatedAt: 'y' };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(row), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await hub.updateFeedback({ traceId: 't1', feedbackId: 'f1', rating: -1 });
    expect(result.rating).toBe(-1);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/traces/t1/feedback/f1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ rating: -1 });
  });

  it('getTrace GETs /traces/:id and returns the trace + span tree', async () => {
    const body = { trace: { id: 't1', name: 'run', sessionId: null, status: 'ok', startedAt: 'x', endedAt: 'y', spanCount: 1, totalCostUsd: null, totalTokens: null }, spans: [] };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await hub.getTrace('t1');
    expect(result).toEqual(body);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/traces/t1');
    expect(init.method).toBe('GET');
  });

  it('listTraces GETs /traces with filters serialized as query params', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: [], total: 0, page: 1, limit: 20 }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await hub.listTraces({ status: 'ok', model: 'gpt-4o-mini', sessionId: 's1', page: 2, limit: 10 });

    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/traces?status=ok&model=gpt-4o-mini&session_id=s1&page=2&limit=10');
  });

  it('throws API_ERROR when getTrace is called with an unknown id', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Trace not found.' } }), { status: 404 }));
    await expect(hub.getTrace('unknown')).rejects.toThrow(acruxcoreError);
  });
});

// ── Finding #20: SDK cache key must not embed the raw API key ─────────────

describe('Finding #20: cache key does not embed the raw apiKey', () => {
  beforeEach(() => {
    _resetCacheForTesting();
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetCacheForTesting();
  });

  it('stores the render cache entry under a hashed key, never the raw apiKey', async () => {
    const rawKey = 'sk-super-secret-raw-key';
    const hub = new acruxcore({ apiKey: rawKey, baseUrl: 'http://localhost:3000' });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await hub.renderPrompt('my-prompt', 'production');

    const cache = getCache(500);
    const keys = [...cache.keys()];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain(rawKey);
    }
  });
});

// ── Finding #21: warn (not throw) when baseUrl isn't HTTPS/loopback ────────

describe('Finding #21: HTTPS enforcement warning on baseUrl', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetCacheForTesting();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    _resetCacheForTesting();
  });

  it('warns once for a plain-http, non-loopback baseUrl', () => {
    new acruxcore({ apiKey: 'k', baseUrl: 'http://example.com' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/https/i);
  });

  it('does not warn for an https:// baseUrl', () => {
    new acruxcore({ apiKey: 'k', baseUrl: 'https://example.com' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn for http://localhost — legitimate local dev', () => {
    new acruxcore({ apiKey: 'k', baseUrl: 'http://localhost:3000' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn for http://127.0.0.1 — legitimate local dev', () => {
    new acruxcore({ apiKey: 'k', baseUrl: 'http://127.0.0.1:3000' });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ── Finding #22: one auth-header helper used by all three call paths ──────

describe('Finding #22: auth-header construction is not duplicated/drifted', () => {
  let hub: acruxcore;

  beforeEach(() => {
    _resetCacheForTesting();
    vi.stubGlobal('fetch', vi.fn());
    hub = new acruxcore({ apiKey: 'test-key', baseUrl: 'http://localhost:3000' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetCacheForTesting();
  });

  it('renderPrompt, trace, and chat all send an identical Authorization/Content-Type header shape', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await hub.renderPrompt('p', 'production');
    const renderHeaders = (vi.mocked(fetch).mock.calls[0]![1] as RequestInit).headers as Record<string, string>;

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ accepted: 1, traceIds: ['t1'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await hub.trace({ spans: [] });
    const traceHeaders = (vi.mocked(fetch).mock.calls[1]![1] as RequestInit).headers as Record<string, string>;

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await hub.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    const chatHeaders = (vi.mocked(fetch).mock.calls[2]![1] as RequestInit).headers as Record<string, string>;

    expect(renderHeaders['Authorization']).toBe('Bearer test-key');
    expect(renderHeaders['Authorization']).toBe(traceHeaders['Authorization']);
    expect(renderHeaders['Authorization']).toBe(chatHeaders['Authorization']);
    expect(renderHeaders['Content-Type']).toBe(traceHeaders['Content-Type']);
    expect(renderHeaders['Content-Type']).toBe(chatHeaders['Content-Type']);
  });

  it('_authHeaders merges extraHeaders on top of the base Authorization/Content-Type pair', () => {
    // Reaches into the private helper directly: this test exists specifically to
    // prove the shared helper's own contract, independent of any one call site.
    const authHeaders = (hub as unknown as { _authHeaders: (extra?: Record<string, string>) => Record<string, string> })._authHeaders;
    expect(authHeaders.call(hub)).toEqual({ Authorization: 'Bearer test-key', 'Content-Type': 'application/json' });
    expect(authHeaders.call(hub, { 'x-trace-id': 'abc' })).toEqual({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
      'x-trace-id': 'abc',
    });
  });
});
