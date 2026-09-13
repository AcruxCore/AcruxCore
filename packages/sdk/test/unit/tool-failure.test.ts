import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acruxcore } from '../../src/client';
import { _resetCacheForTesting } from '../../src/cache';
import { _resetSyncCacheForTesting } from '../../src/tools-api';
import { toolError, toolWarning } from '../../src/tool-result';

/**
 * Issue #452 — a client-side tool that knows it failed must be able to say so, and the
 * span it produces must match the one the platform writes for an `http` tool. Every
 * assertion here reads the span the SDK actually POSTs to `/traces`, because the bug
 * being fixed was exactly that the loop looked fine while the recorded span lied.
 */
describe('client-side tool failure reporting', () => {
  let hub: acruxcore;

  const jsonResponse = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });

  const TOOL_CALL_ROUND = {
    id: 'chatcmpl-1',
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Atlantis"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };

  const FINAL_ROUND = {
    id: 'chatcmpl-2',
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'No data for Atlantis.' }, finish_reason: 'stop' }],
  };

  const resolved = (extra: Record<string, unknown> = {}) => ({
    data: [
      {
        toolId: 'tool-1',
        versionNumber: 4,
        executorType: 'client',
        function: { name: 'get_weather', parameters: { type: 'object' } },
        ...extra,
      },
    ],
  });

  const calls = () => (global.fetch as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];

  /** Every `tool` span the SDK reported, across all `/traces` posts. */
  const reportedToolSpans = () =>
    calls()
      .filter(([url]) => url.includes('/traces'))
      .flatMap(([, init]) => {
        const body = JSON.parse(String(init.body)) as { traces: { spans: Record<string, unknown>[] }[] };
        return body.traces.flatMap((t) => t.spans);
      })
      .filter((s) => s['kind'] === 'tool');

  beforeEach(() => {
    _resetCacheForTesting();
    _resetSyncCacheForTesting();
    vi.stubGlobal('fetch', vi.fn());
    hub = new acruxcore({ apiKey: 'test-key', baseUrl: 'http://localhost:3000' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetCacheForTesting();
  });

  it('turns a toolError return into a red span while the loop keeps going', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(resolved()))
      .mockResolvedValueOnce(jsonResponse(TOOL_CALL_ROUND, { 'x-gateway-trace-id': 'tr-1' }))
      .mockResolvedValueOnce(jsonResponse(FINAL_ROUND))
      .mockResolvedValue(jsonResponse({ traceIds: ['tr-1'] }));

    const result = await hub.gateway.runToolLoop({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Weather in Atlantis?' }],
      toolRefs: [{ name: 'get_weather' }],
      clientTools: {
        get_weather: () =>
          toolError('location_not_found', 'No weather data for Atlantis', { error: 'not found' }),
      },
    });
    await hub.gateway.flush();

    // Declaring a failure does NOT stop the loop — that stays the caller's decision.
    expect(result.content).toBe('No data for Atlantis.');

    const spans = reportedToolSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      status: 'error',
      error: 'No weather data for Atlantis',
      output: { error: 'not found' },
      attributes: {
        errorType: 'tool_declared',
        // The slug the tool chose, kept as its own attribute so it can be matched on.
        // `errorType` says which classifier fired; `errorCode` says what the tool called it.
        errorCode: 'location_not_found',
        errorDetail: 'No weather data for Atlantis',
      },
    });

    // The model reads the `result`, not the sentinel wrapper.
    const secondRound = calls().filter(([url]) => url.includes('/chat/completions'))[1]!;
    const messages = (JSON.parse(String(secondRound[1].body)) as { messages: { content: string }[] }).messages;
    expect(messages.at(-1)!.content).toBe('{"error":"not found"}');
  });

  it('leaves a toolWarning span green and attaches the warning', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(resolved()))
      .mockResolvedValueOnce(jsonResponse(TOOL_CALL_ROUND, { 'x-gateway-trace-id': 'tr-1' }))
      .mockResolvedValueOnce(jsonResponse(FINAL_ROUND))
      .mockResolvedValue(jsonResponse({ traceIds: ['tr-1'] }));

    await hub.gateway.runToolLoop({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Weather?' }],
      toolRefs: [{ name: 'get_weather' }],
      clientTools: {
        get_weather: () => toolWarning('stale_data', 'cache is 6h old', { tempC: 18 }),
      },
    });
    await hub.gateway.flush();

    const spans = reportedToolSpans();
    // A warning is not a verdict about whether the run succeeded, so the span stays ok.
    expect(spans[0]).toMatchObject({
      status: 'ok',
      output: { tempC: 18 },
      attributes: { errorCode: 'stale_data', warning: { type: 'stale_data', message: 'cache is 6h old' } },
    });
    expect(spans[0]!['error']).toBeUndefined();
  });

  it('checks a client tool against the catalog resultSchema it was resolved with', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(
          resolved({
            resultSchema: { type: 'object', properties: { tempC: { type: 'number' } }, required: ['tempC'] },
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(TOOL_CALL_ROUND, { 'x-gateway-trace-id': 'tr-1' }))
      .mockResolvedValueOnce(jsonResponse(FINAL_ROUND))
      .mockResolvedValue(jsonResponse({ traceIds: ['tr-1'] }));

    await hub.gateway.runToolLoop({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Weather?' }],
      toolRefs: [{ name: 'get_weather' }],
      clientTools: { get_weather: () => ({ tempC: 'quite warm' }) },
    });
    await hub.gateway.flush();

    // Warn by default: the declaration may itself be the wrong one, and a check that
    // cries wolf gets switched off, taking the real signal with it.
    expect(reportedToolSpans()[0]).toMatchObject({
      status: 'ok',
      attributes: { errorType: 'schema_mismatch', warning: { type: 'schema_mismatch' } },
    });
  });

  it('promotes the mismatch to an error when the catalog says so', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(
          resolved({
            resultSchema: { type: 'object', required: ['tempC'] },
            resultSchemaSeverity: 'error',
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(TOOL_CALL_ROUND, { 'x-gateway-trace-id': 'tr-1' }))
      .mockResolvedValueOnce(jsonResponse(FINAL_ROUND))
      .mockResolvedValue(jsonResponse({ traceIds: ['tr-1'] }));

    await hub.gateway.runToolLoop({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Weather?' }],
      toolRefs: [{ name: 'get_weather' }],
      clientTools: { get_weather: () => ({ humidity: 40 }) },
    });
    await hub.gateway.flush();

    expect(reportedToolSpans()[0]).toMatchObject({
      status: 'error',
      attributes: { errorType: 'schema_mismatch' },
    });
  });

  it('leaves a plain return value exactly as it was', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(resolved()))
      .mockResolvedValueOnce(jsonResponse(TOOL_CALL_ROUND, { 'x-gateway-trace-id': 'tr-1' }))
      .mockResolvedValueOnce(jsonResponse(FINAL_ROUND))
      .mockResolvedValue(jsonResponse({ traceIds: ['tr-1'] }));

    await hub.gateway.runToolLoop({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Weather?' }],
      toolRefs: [{ name: 'get_weather' }],
      clientTools: { get_weather: () => ({ tempC: 18 }) },
    });
    await hub.gateway.flush();

    const span = reportedToolSpans()[0]!;
    expect(span).toMatchObject({ status: 'ok', output: { tempC: 18 } });
    expect(span['attributes']).not.toHaveProperty('errorType');
    expect(span['attributes']).not.toHaveProperty('warning');
  });

  it('still reports the tool spans when a later round throws', async () => {
    // The round after the tool call fails. Before the try/finally, the tool span that had
    // already run was discarded, and the trace showed a run that called no tools at all.
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(resolved()))
      .mockResolvedValueOnce(jsonResponse(TOOL_CALL_ROUND, { 'x-gateway-trace-id': 'tr-1' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'PROVIDER_ERROR', message: 'upstream exploded' } }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValue(jsonResponse({ traceIds: ['tr-1'] }));

    await expect(
      hub.gateway.runToolLoop({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Weather?' }],
        toolRefs: [{ name: 'get_weather' }],
        clientTools: { get_weather: () => ({ tempC: 18 }) },
      }),
    ).rejects.toThrow();
    await hub.gateway.flush();

    expect(reportedToolSpans()).toHaveLength(1);
    expect(reportedToolSpans()[0]).toMatchObject({ name: 'get_weather', status: 'ok' });
  });
});
