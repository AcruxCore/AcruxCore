import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acruxcore } from '../../src/client';
import { acruxcoreError } from '../../src/error';
import { _resetCacheForTesting } from '../../src/cache';

/**
 * Unit coverage for `hub.prompts.*ToolBinding*` — the six prompt→tool binding
 * endpoints. Asserts the wire contract each method has to hold up: the URL, the
 * method, and the snake_case body the API validates.
 */
describe('prompt tool bindings', () => {
  let hub: acruxcore;

  const detail = {
    toolId: 'tool-1',
    toolName: 'get_weather',
    toolAlias: 'production',
    pinnedVersionNumber: null,
    off: false,
    resolvedVersionNumber: 3,
    position: 0,
  };

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const lastCall = () =>
    (global.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [string, RequestInit];

  beforeEach(() => {
    _resetCacheForTesting();
    vi.stubGlobal('fetch', vi.fn());
    hub = new acruxcore({ apiKey: 'test-key', baseUrl: 'http://localhost:3000' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetCacheForTesting();
  });

  it('unwraps the data envelope on GET /prompts/:id/tools', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        data: {
          default: [detail],
          aliases: [
            { alias: 'production', versionNumber: 2, customised: false, bindings: [] },
            { alias: 'staging', versionNumber: 2, customised: true, bindings: [detail] },
          ],
        },
      }),
    );

    const bindings = await hub.prompts.listToolBindings('p-1');

    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:3000/prompts/p-1/tools');
    expect(init.method).toBe('GET');
    expect(bindings.default).toEqual([detail]);
    expect(bindings.aliases.map((a) => a.customised)).toEqual([false, true]);
  });

  it('PUTs the default binding with a snake_case tool_alias body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(detail));

    const result = await hub.prompts.setToolBinding('p-1', 'tool-1', { toolAlias: 'production' });

    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:3000/prompts/p-1/tools/tool-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ tool_alias: 'production' });
    expect(result).toEqual(detail);
  });

  it('PUTs a pin as pinned_version_number', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ ...detail, toolAlias: null, pinnedVersionNumber: 2, resolvedVersionNumber: 2 }),
    );

    await hub.prompts.setToolBinding('p-1', 'tool-1', { pinnedVersionNumber: 2 });

    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ pinned_version_number: 2 });
  });

  it('DELETEs the default binding and returns nothing on 204', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(hub.prompts.removeToolBinding('p-1', 'tool-1')).resolves.toBeUndefined();

    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:3000/prompts/p-1/tools/tool-1');
    expect(init.method).toBe('DELETE');
  });

  it('throws the typed API error when a delete comes back non-2xx', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ error: { code: 'NOT_FOUND', message: 'no such binding' } }, 404),
    );

    await expect(hub.prompts.removeToolBinding('p-1', 'tool-1')).rejects.toThrow(acruxcoreError);
  });

  it("PUTs one prompt alias's own binding under /aliases/:alias/tools/:toolId", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ...detail, toolAlias: 'staging' }));

    await hub.prompts.setAliasToolBinding('p-1', 'staging', 'tool-1', { toolAlias: 'staging' });

    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:3000/prompts/p-1/aliases/staging/tools/tool-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ tool_alias: 'staging' });
  });

  it('sends { off: true } for an alias that deliberately has no such tool', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ ...detail, toolAlias: null, off: true, resolvedVersionNumber: null }),
    );

    const result = await hub.prompts.setAliasToolBinding('p-1', 'staging', 'tool-1', { off: true });

    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ off: true });
    expect(result.off).toBe(true);
  });

  it('rejects { off: true } on the default binding before sending anything', async () => {
    await expect(
      // Only valid per-alias — cast past the type that already forbids it, to prove the
      // runtime guard a plain-JavaScript caller would hit.
      hub.prompts.setToolBinding('p-1', 'tool-1', { off: true } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects a binding with no target before sending anything', async () => {
    await expect(
      hub.prompts.setAliasToolBinding('p-1', 'staging', 'tool-1', {} as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("DELETEs one alias's binding, and every binding it owns", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await hub.prompts.removeAliasToolBinding('p-1', 'staging', 'tool-1');
    expect(lastCall()[0]).toBe('http://localhost:3000/prompts/p-1/aliases/staging/tools/tool-1');

    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await hub.prompts.resetAliasToolBindings('p-1', 'staging');
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:3000/prompts/p-1/aliases/staging/tools');
    expect(init.method).toBe('DELETE');
  });

  it('surfaces the resolution source render() reports for each bound tool', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{ type: 'function', function: { name: 'get_weather' } }],
        toolResolutions: [
          { name: 'get_weather', alias: 'staging', versionNumber: 4, source: 'alias' },
        ],
      }),
    );

    const rendered = await hub.prompts.render('greeting', 'staging');

    expect(rendered.toolResolutions).toEqual([
      { name: 'get_weather', alias: 'staging', versionNumber: 4, source: 'alias' },
    ]);
  });
});
