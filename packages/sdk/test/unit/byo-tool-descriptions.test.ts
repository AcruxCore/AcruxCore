import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acruxcore } from '../../src/client';
import { _resetCacheForTesting } from '../../src/cache';
import { _resetSyncCacheForTesting } from '../../src/tools-api';
import { acrux } from '../../src/tools';

/**
 * A tool declared with no `description` must still reach a BYO provider with its
 * catalog description (issue #433).
 *
 * Omitting the description is the documented way to hand the model-facing text to a
 * non-engineer in the dashboard. On the gateway path the gateway resolves `toolRefs`
 * and substitutes the catalog definition. A BYO provider gets only what the SDK
 * inlines, so the SDK has to do that resolution itself.
 */
describe('BYO provider tool descriptions', () => {
  let hub: acruxcore;

  const PROVIDER = { baseUrl: 'https://provider.invalid/v1', apiKey: 'pk' };

  const PLAIN_COMPLETION = {
    id: 'chatcmpl-1',
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
  };

  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const calls = () =>
    (global.fetch as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];

  const bodyOf = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, any>;

  /** The tool array as the BYO provider received it, name → description. */
  const providerToolDescriptions = () => {
    const [, init] = calls().find(([url]) => url.includes('provider.invalid'))!;
    const tools = bodyOf(init)['tools'] as Array<{ function: { name: string; description?: string } }>;
    return Object.fromEntries(tools.map((t) => [t.function.name, t.function.description]));
  };

  const described = acrux.tool(
    {
      name: 'query_database',
      description: 'Run a read-only SQL SELECT against the store database.',
      parameters: { type: 'object', properties: { sql: { type: 'string' } } },
    },
    () => '[]',
  );

  const undescribed = acrux.tool(
    { name: 'check_disclosure_policy', parameters: { type: 'object', properties: { topic: { type: 'string' } } } },
    () => 'ok',
  );

  /** Answers /tools/sync, then /tools/resolve, then the provider. */
  // `null` rather than `undefined` for the absent case: passing undefined to a default
  // parameter silently picks the default back up.
  const stubFetch = (catalogDescription: string | null = 'Check the topic against the policy.') => {
    vi.mocked(fetch).mockImplementation(async (input: any, init: any) => {
      const url = String(input);
      if (url.includes('/tools/sync')) {
        const name = bodyOf(init)['name'];
        return jsonResponse({ toolId: `t-${name}`, versionNumber: 2, committed: true, alias: 'production' });
      }
      if (url.includes('/tools/resolve')) {
        const refs = bodyOf(init)['refs'] as Array<{ name: string }>;
        return jsonResponse({
          data: refs.map((r) => ({
            toolId: `t-${r.name}`,
            versionNumber: 2,
            executorType: 'client',
            function: {
              name: r.name,
              ...(catalogDescription ? { description: catalogDescription } : {}),
              parameters: { type: 'object' },
            },
          })),
        });
      }
      if (url.includes('/traces')) return jsonResponse({ traceId: 'tr-1' });
      return jsonResponse(PLAIN_COMPLETION);
    });
  };

  beforeEach(() => {
    _resetCacheForTesting();
    _resetSyncCacheForTesting();
    vi.stubGlobal('fetch', vi.fn());
    hub = new acruxcore({ apiKey: 'test-key', baseUrl: 'http://localhost:3000' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _resetCacheForTesting();
  });

  it('gives a BYO provider the catalog description for an undescribed tool', async () => {
    stubFetch();

    await hub.gateway.runToolLoop({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Can I talk about this?' }],
      tools: [described, undescribed],
      provider: PROVIDER,
    });

    expect(providerToolDescriptions()).toEqual({
      query_database: 'Run a read-only SQL SELECT against the store database.',
      check_disclosure_policy: 'Check the topic against the policy.',
    });
  });

  it('costs one resolve call, for the undescribed tool only', async () => {
    stubFetch();

    await hub.gateway.runToolLoop({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [described, undescribed],
      provider: PROVIDER,
    });

    expect(calls().filter(([url]) => url.includes('/tools/resolve'))).toHaveLength(1);
  });

  it('resolves nothing on the gateway path, because the gateway does it', async () => {
    stubFetch();

    await hub.gateway.runToolLoop({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [described, undescribed],
    });

    expect(calls().filter(([url]) => url.includes('/tools/resolve'))).toHaveLength(0);
    const [, init] = calls().find(([url]) => url.includes('/gateway/chat/completions'))!;
    expect((bodyOf(init)['tool_refs'] as Array<{ name: string }>).map((r) => r.name)).toEqual([
      'query_database',
      'check_disclosure_policy',
    ]);
  });

  it('warns rather than sending a tool described nowhere', async () => {
    stubFetch(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await hub.gateway.runToolLoop({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [undescribed],
      provider: PROVIDER,
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('check_disclosure_policy'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no description'));
    expect(providerToolDescriptions()).toEqual({ check_disclosure_policy: undefined });
  });

  it('warns instead of resolving a tool that sync was turned off for', async () => {
    stubFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await hub.gateway.runToolLoop({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [undescribed],
      provider: PROVIDER,
      sync: false,
    });

    expect(calls().filter(([url]) => url.includes('/tools/resolve'))).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sync is off'));
  });
});
