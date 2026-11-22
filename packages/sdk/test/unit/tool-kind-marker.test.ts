import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acruxcore } from '../../src/client';
import { _resetCacheForTesting } from '../../src/cache';
import { _resetSyncCacheForTesting } from '../../src/tools-api';
import { tool } from '../../src/tools';

/**
 * Issue #870, layer 3 — `tool({ kind: 'retrieval' })` and `kind: 'tool'` reach the
 * platform as the span attribute `toolKind`, which the trace view reads before guessing
 * from the output's shape. The assertions read the spans the SDK actually POSTs.
 */
describe('tool kind marker', () => {
  let hub: acruxcore;

  const jsonResponse = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

  const TOOL_CALL_ROUND = {
    id: 'c1',
    model: 'gpt-4o-mini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_kb', arguments: '{"query":"refunds"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  };
  const FINAL_ROUND = {
    id: 'c2',
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Five days.' }, finish_reason: 'stop' }],
  };

  const toolSpans = () =>
    (vi.mocked(fetch).mock.calls as [string, RequestInit][])
      .filter(([url]) => url.includes('/traces'))
      .flatMap(([, init]) => (JSON.parse(String(init.body)) as { traces: { spans: Record<string, unknown>[] }[] }).traces.flatMap((t) => t.spans))
      .filter((s) => s['kind'] === 'tool');

  const runWith = async (declared: ReturnType<typeof tool>) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(TOOL_CALL_ROUND, { 'x-gateway-trace-id': 'tr-1' }))
      .mockResolvedValueOnce(jsonResponse(FINAL_ROUND))
      .mockResolvedValue(jsonResponse({ traceIds: ['tr-1'] }));
    await hub.gateway.runToolLoop({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Refund window?' }],
      tools: [declared],
      sync: false,
    });
    await hub.gateway.flush();
    return toolSpans();
  };

  const params = { type: 'object', properties: { query: { type: 'string' } } };

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

  it("writes kind: 'retrieval' as toolKind and keeps the span a tool span", async () => {
    const spans = await runWith(
      tool({ name: 'search_kb', description: 'Search', parameters: params, kind: 'retrieval' }, () => 'Doc 1: Refunds take 5 days.'),
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ kind: 'tool', attributes: { toolKind: 'retrieval' } });
  });

  it("writes kind: 'tool' so detection can be turned off", async () => {
    const spans = await runWith(
      tool({ name: 'search_kb', description: 'Search', parameters: params, kind: 'tool' }, () => [{ text: 'Sunny' }]),
    );
    expect(spans[0]).toMatchObject({ attributes: { toolKind: 'tool' } });
  });

  it('sends no toolKind for an unmarked tool', async () => {
    const spans = await runWith(tool({ name: 'search_kb', description: 'Search', parameters: params }, () => 'x'));
    expect(spans[0]['attributes']).not.toHaveProperty('toolKind');
  });

  it('rejects an unknown kind when the tool is declared', () => {
    expect(() =>
      tool({ name: 'search_kb', parameters: params, kind: 'search' as never }, () => 'x'),
    ).toThrow(/kind/);
  });
});
