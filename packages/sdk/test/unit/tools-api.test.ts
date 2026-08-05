import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// zod's v4 API — the only one `toJSONSchema` can convert. On zod 4 proper this is `from 'zod'`.
import { z } from 'zod/v4';
import { acruxcore } from '../../src/client';
import { acruxcoreError } from '../../src/error';
import { acrux } from '../../src/tools';
import { _resetSyncCacheForTesting } from '../../src/tools-api';
import { _resetCacheForTesting } from '../../src/cache';

/** JSON response helper, matching what the real API sends. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The recorded body of the Nth fetch call. */
function bodyOf(callIndex: number): Record<string, unknown> {
  const [, init] = vi.mocked(fetch).mock.calls[callIndex] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

/** The recorded URL of the Nth fetch call. */
function urlOf(callIndex: number): string {
  return vi.mocked(fetch).mock.calls[callIndex]?.[0] as string;
}

const getWeather = acrux.tool(
  {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: z.object({ city: z.string().describe('City name.') }),
  },
  async ({ city }) => ({ city, tempC: 18 }),
);

/** A tool with NO description — the case that hands ownership to the dashboard. */
const countRows = acrux.tool(
  { name: 'count_rows', parameters: z.object({ table: z.string() }) },
  async () => 0,
);

describe('hub.tools', () => {
  let hub: acruxcore;

  beforeEach(() => {
    _resetCacheForTesting();
    _resetSyncCacheForTesting();
    vi.stubGlobal('fetch', vi.fn());
    hub = new acruxcore({
      apiKey: 'test-key',
      baseUrl: 'http://localhost:3000',
      maxRetries: 0,
      retryInterval: 1,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _resetSyncCacheForTesting();
  });

  it('sync posts the resolved JSON Schema with source code', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ toolId: 't-1', versionNumber: 3, committed: true, alias: 'production' }),
    );

    const results = await hub.tools.sync([getWeather]);

    expect(results).toHaveLength(1);
    expect(results[0]?.toolId).toBe('t-1');
    expect(results[0]?.versionNumber).toBe(3);
    expect(results[0]?.committed).toBe(true);
    expect(results[0]?.supersededSource).toBeUndefined();

    expect(urlOf(0)).toBe('http://localhost:3000/tools/sync');
    const body = bodyOf(0);
    expect(body['name']).toBe('get_weather');
    expect(body['description']).toBe('Get the current weather for a city.');
    expect(body['executor']).toEqual({ type: 'client' });
    expect(body['alias']).toBe('production');
    expect(body['source']).toBe('code');
    // The zod schema became JSON Schema, .describe() text and all.
    expect(body['parametersSchema']).toMatchObject({
      type: 'object',
      properties: { city: { type: 'string', description: 'City name.' } },
      required: ['city'],
    });
  });

  it('sync sends no description key for a tool that declares none', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ toolId: 't-2', versionNumber: 1, committed: true, alias: 'production' }),
    );

    await hub.tools.sync([countRows]);

    // Omitting the key is what hands description ownership to the dashboard; sending
    // null would erase whatever was written there.
    expect(bodyOf(0)).not.toHaveProperty('description');
  });

  it('sync is cached by spec so a second call makes no request', async () => {
    vi.mocked(fetch).mockResolvedValue(
      json({ toolId: 't-1', versionNumber: 1, committed: true, alias: 'production' }),
    );

    await hub.tools.sync([getWeather]);
    const second = await hub.tools.sync([getWeather]);

    expect(fetch).toHaveBeenCalledTimes(1);
    // The cached result reports committed false: nothing was committed THIS time.
    expect(second[0]?.committed).toBe(false);
    expect(second[0]?.toolId).toBe('t-1');
  });

  it('sync warns once when it supersedes a dashboard version', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValueOnce(
      json({
        toolId: 't-1',
        versionNumber: 4,
        committed: true,
        alias: 'production',
        supersededSource: 'dashboard',
      }),
    );

    const results = await hub.tools.sync([getWeather]);

    expect(results[0]?.supersededSource).toBe('dashboard');
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('get_weather');
    expect(message).toContain('dashboard');
    expect(message).toContain('v4');
  });

  it('sync with onConflict error throws instead of warning', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({
        toolId: 't-1',
        versionNumber: 4,
        committed: true,
        alias: 'production',
        supersededSource: 'dashboard',
      }),
    );

    await expect(hub.tools.sync([getWeather], { onConflict: 'error' })).rejects.toThrowError(
      /dashboard/,
    );
  });

  it('sync rejects a value that did not come from acrux.tool', async () => {
    const notATool = { name: 'get_weather', handler: () => null } as never;
    await expect(hub.tools.sync([notATool])).rejects.toThrowError(/acrux\.tool/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolve posts a batch and parses executor types', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({
        data: [
          {
            toolId: 't-1',
            versionNumber: 2,
            executorType: 'http',
            function: { name: 'get_weather', description: 'W.', parameters: {} },
          },
        ],
      }),
    );

    const resolved = await hub.tools.resolve([{ name: 'get_weather', alias: 'production' }]);

    expect(urlOf(0)).toBe('http://localhost:3000/tools/resolve');
    expect(bodyOf(0)).toEqual({ refs: [{ name: 'get_weather', alias: 'production' }] });
    expect(resolved[0]?.executorType).toBe('http');
    expect(resolved[0]?.toolId).toBe('t-1');
    expect(resolved[0]?.function.name).toBe('get_weather');
  });

  it('resolve omits a missing alias so the server default applies', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ data: [] }));
    await hub.tools.resolve([{ name: 'get_weather' }]);
    expect(bodyOf(0)).toEqual({ refs: [{ name: 'get_weather' }] });
  });

  it('resolve surfaces the 404 with the failing refs', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'TOOL_REF_NOT_FOUND',
            message: 'nope',
            refs: [{ name: 'ghost', alias: 'production' }],
          },
        },
        404,
      ),
    );

    await expect(hub.tools.resolve([{ name: 'ghost' }])).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('resolve 404 keeps the failing refs on the error body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'TOOL_REF_NOT_FOUND',
            message: 'nope',
            refs: [{ name: 'ghost', alias: 'production' }],
          },
        },
        404,
      ),
    );

    try {
      await hub.tools.resolve([{ name: 'ghost' }]);
      expect.unreachable('resolve should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(acruxcoreError);
      expect(JSON.stringify((err as acruxcoreError).body)).toContain('ghost');
    }
  });

  it('execute posts arguments and trace context', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ result: { tempC: 18 }, status: 200, latencyMs: 42, toolVersionId: 'v-1' }),
    );

    const out = await hub.tools.execute(
      't-1',
      { city: 'Lahore' },
      { alias: 'production', traceId: 'tr-1', parentSpanId: 'sp-1' },
    );

    expect(urlOf(0)).toBe('http://localhost:3000/tools/t-1/execute');
    expect(out.result).toEqual({ tempC: 18 });
    expect(out.latencyMs).toBe(42);
    expect(out.toolVersionId).toBe('v-1');
    expect(bodyOf(0)).toEqual({
      arguments: { city: 'Lahore' },
      alias: 'production',
      traceContext: { traceId: 'tr-1', parentSpanId: 'sp-1' },
    });
  });

  it('execute sends no trace context when none is given', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ result: 1, status: 200, latencyMs: 3, toolVersionId: 'v-1' }),
    );
    await hub.tools.execute('t-1', { city: 'Lahore' });
    expect(bodyOf(0)).toEqual({ arguments: { city: 'Lahore' } });
  });
});

// ── runToolLoop routing ─────────────────────────────────────────────────────

describe('runToolLoop routing', () => {
  let hub: acruxcore;

  beforeEach(() => {
    _resetCacheForTesting();
    _resetSyncCacheForTesting();
    vi.stubGlobal('fetch', vi.fn());
    hub = new acruxcore({
      apiKey: 'test-key',
      baseUrl: 'http://localhost:3000',
      maxRetries: 0,
      retryInterval: 1,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _resetSyncCacheForTesting();
  });

  /**
   * Plays a full one-tool loop off a single URL-dispatching mock, recording every path
   * so a test can assert which round-trips did and did not happen.
   */
  function installLoopFetch(opts: { executorType?: 'client' | 'http'; paths: string[] }): void {
    let completions = 0;
    vi.mocked(fetch).mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      opts.paths.push(path);
      if (path.endsWith('/tools/sync')) {
        return json({ toolId: 't-1', versionNumber: 1, committed: true, alias: 'production' });
      }
      if (path.endsWith('/tools/resolve')) {
        return json({
          data: [
            {
              toolId: 't-1',
              versionNumber: 1,
              executorType: opts.executorType ?? 'client',
              function: { name: 'get_weather', description: 'W.', parameters: {} },
            },
          ],
        });
      }
      if (path.endsWith('/tools/t-1/execute')) {
        return json({ result: { tempC: 30 }, status: 200, latencyMs: 12, toolVersionId: 'v-1' });
      }
      if (path.endsWith('/traces')) return json({ accepted: 1, traceIds: ['tr-1'] });
      if (path.endsWith('/gateway/chat/completions')) {
        completions += 1;
        if (completions === 1) {
          return new Response(
            JSON.stringify({
              id: 'c1',
              model: 'm',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'get_weather', arguments: '{"city":"Lahore"}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json',
                'x-gateway-trace-id': 'tr-1',
                'x-gateway-span-id': 'sp-1',
              },
            },
          );
        }
        return new Response(
          JSON.stringify({
            id: 'c2',
            model: 'm',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'It is 30C.' }, finish_reason: 'stop' },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json', 'x-gateway-trace-id': 'tr-1' },
          },
        );
      }
      return json({}, 404);
    });
  }

  it('syncs a declared tool then runs it locally, with no resolve round-trip', async () => {
    const ran: string[] = [];
    const weather = acrux.tool(
      { name: 'get_weather', description: 'W.', parameters: z.object({ city: z.string() }) },
      async ({ city }) => {
        ran.push(city);
        return { tempC: 30 };
      },
    );
    const paths: string[] = [];
    installLoopFetch({ paths });

    const result = await hub.gateway.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: '?' }],
      tools: [weather],
    });

    expect(result.content).toBe('It is 30C.');
    expect(ran).toEqual(['Lahore']);
    expect(paths.some((p) => p.endsWith('/tools/sync'))).toBe(true);
    // A declared tool is client-side by definition — no resolve is needed.
    expect(paths.some((p) => p.endsWith('/tools/resolve'))).toBe(false);
  });

  it('sends tool_refs rather than an inline schema for declared tools', async () => {
    const weather = acrux.tool(
      { name: 'get_weather', description: 'W.', parameters: z.object({ city: z.string() }) },
      async () => ({ tempC: 30 }),
    );
    const paths: string[] = [];
    installLoopFetch({ paths });

    await hub.gateway.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: '?' }],
      tools: [weather],
    });

    const completionCall = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).endsWith('/gateway/chat/completions'));
    const body = JSON.parse((completionCall?.[1] as RequestInit).body as string);
    // The catalog serves the schema, so the declared one cannot diverge from it.
    expect(body.tool_refs).toEqual([{ name: 'get_weather', alias: 'production' }]);
    expect(body).not.toHaveProperty('tools');
  });

  it('runs an http executor on the platform and writes no tool span', async () => {
    const paths: string[] = [];
    installLoopFetch({ executorType: 'http', paths });

    const result = await hub.gateway.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: '?' }],
      toolRefs: [{ name: 'get_weather', alias: 'production' }],
    });

    expect(result.content).toBe('It is 30C.');
    expect(paths.some((p) => p.endsWith('/tools/t-1/execute'))).toBe(true);
    // The platform records the tool span for a server-side execution; reporting one here
    // as well would show the same call twice in the waterfall.
    expect(paths.some((p) => p.endsWith('/traces'))).toBe(false);
  });

  it('throws MISSING_DISPATCH before the model when a client ref has no runner', async () => {
    const paths: string[] = [];
    installLoopFetch({ executorType: 'client', paths });

    await expect(
      hub.gateway.runToolLoop({
        model: 'm',
        messages: [{ role: 'user', content: '?' }],
        toolRefs: [{ name: 'get_weather' }],
      }),
    ).rejects.toMatchObject({ code: 'MISSING_DISPATCH' });

    // Failing fast matters: no tokens were spent finding this out.
    expect(paths.some((p) => p.endsWith('/gateway/chat/completions'))).toBe(false);
  });

  it('still accepts a dispatch for a client ref', async () => {
    const paths: string[] = [];
    installLoopFetch({ executorType: 'client', paths });

    const result = await hub.gateway.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: '?' }],
      toolRefs: [{ name: 'get_weather' }],
      dispatch: () => ({ tempC: 30 }),
    });
    expect(result.content).toBe('It is 30C.');
  });

  it('prefers a declared tool over a ref of the same name', async () => {
    const ran: string[] = [];
    const weather = acrux.tool(
      { name: 'get_weather', description: 'W.', parameters: z.object({ city: z.string() }) },
      async ({ city }) => {
        ran.push(city);
        return { tempC: 30 };
      },
    );
    const paths: string[] = [];
    installLoopFetch({ executorType: 'http', paths });

    await hub.gateway.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: '?' }],
      tools: [weather],
      toolRefs: [{ name: 'get_weather' }],
    });

    // The caller wrote the body, so running it elsewhere would ignore their code.
    expect(ran).toEqual(['Lahore']);
    expect(paths.some((p) => p.endsWith('/tools/t-1/execute'))).toBe(false);
  });

  it('records executorType and the tool version on a locally-run span', async () => {
    const weather = acrux.tool(
      { name: 'get_weather', description: 'W.', parameters: z.object({ city: z.string() }) },
      async () => ({ tempC: 30 }),
    );
    const paths: string[] = [];
    installLoopFetch({ paths });

    await hub.gateway.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: '?' }],
      tools: [weather],
    });

    const traceCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/traces'));
    const body = JSON.parse((traceCall?.[1] as RequestInit).body as string);
    const span = body.traces[0].spans[0];
    expect(span.kind).toBe('tool');
    expect(span.name).toBe('get_weather');
    // The gap this closes: a tool span used to carry only { arguments }, so the trace
    // could not say which version of the tool ran.
    expect(span.attributes.executorType).toBe('client');
    expect(span.attributes.toolVersionId).toBe('t-1:1');
  });

  it('sync false skips reconciliation', async () => {
    const weather = acrux.tool(
      { name: 'get_weather', description: 'W.', parameters: z.object({ city: z.string() }) },
      async () => ({ tempC: 30 }),
    );
    const paths: string[] = [];
    installLoopFetch({ paths });

    await hub.gateway.runToolLoop({
      model: 'm',
      messages: [{ role: 'user', content: '?' }],
      tools: [weather],
      sync: false,
    });
    expect(paths.some((p) => p.endsWith('/tools/sync'))).toBe(false);
  });
});
