import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acruxcore } from '../../src/client';
import { _resetCacheForTesting } from '../../src/cache';
import { _resetSyncCacheForTesting } from '../../src/tools-api';
import { acrux } from '../../src/tools';
import type { RenderResult, ToolLoopEvent } from '../../src/types';

/**
 * `gateway.runPromptWithTools` and the streaming tool loop.
 *
 * Streamed rounds are served as real SSE bodies so the SDK's own frame parsing and
 * tool-call fragment accumulation are under test, not stubbed.
 */
describe('runPromptWithTools', () => {
  let hub: acruxcore;

  const jsonResponse = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });

  /** An SSE body of chat-completion chunks, terminated with [DONE]. */
  const sseResponse = (frames: unknown[], headers: Record<string, string> = {}) =>
    new Response(
      `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } },
    );

  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: 'chatcmpl-1',
    model: 'gpt-4o-mini',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  const PLAIN_COMPLETION = {
    id: 'chatcmpl-1',
    model: 'gpt-4o-mini',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'Sunny.' }, finish_reason: 'stop' },
    ],
  };

  const resolvedTool = (name: string, executorType: 'client' | 'http' = 'client', versionNumber = 4) => ({
    toolId: 'tool-1',
    versionNumber,
    executorType,
    function: { name, parameters: { type: 'object' } },
  });

  const renderResult = (overrides: Partial<RenderResult> = {}): RenderResult => ({
    messages: [{ role: 'user', content: 'Weather in Lisbon?' }],
    tools: [],
    toolResolutions: [],
    model: 'gpt-4o-mini',
    versionId: 'ver-123',
    versionNumber: 4,
    ...overrides,
  });

  /** Every fetch call as `[url, init]`, in order. */
  const calls = () =>
    (global.fetch as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];

  const bodyOf = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, unknown>;

  /** The bodies sent to the chat-completions endpoint, in order. */
  const chatBodies = () =>
    calls()
      .filter(([url]) => url.includes('/gateway/chat/completions'))
      .map(([, init]) => bodyOf(init));

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

  it('derives model, messages, tool refs and promptVersionId from the render result', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ data: [resolvedTool('get_weather')] }))
      .mockResolvedValueOnce(jsonResponse(PLAIN_COMPLETION, { 'x-gateway-trace-id': 'tr-1' }));

    const result = await hub.gateway.runPromptWithTools(
      renderResult({
        toolResolutions: [
          { name: 'get_weather', alias: 'production', versionNumber: 4, source: 'alias' },
        ],
      }),
      { dispatch: () => 'x' },
    );

    expect(result.content).toBe('Sunny.');
    const [resolveUrl, resolveInit] = calls()[0]!;
    expect(resolveUrl).toContain('/tools/resolve');
    expect(bodyOf(resolveInit)).toEqual({ refs: [{ name: 'get_weather', alias: 'production' }] });

    const chat = chatBodies()[0]!;
    expect(chat['model']).toBe('gpt-4o-mini');
    expect(chat['messages']).toEqual([{ role: 'user', content: 'Weather in Lisbon?' }]);
    expect(chat['tool_refs']).toEqual([{ name: 'get_weather', alias: 'production' }]);
  });

  it("sends the render's versionId to the gateway so its own spans carry lineage", async () => {
    // The gateway writes the llm span on this path, so lineage has to travel in the
    // request body — a client-side field alone would leave the span unlinked.
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(PLAIN_COMPLETION));

    await hub.gateway.runPromptWithTools(renderResult());

    expect(chatBodies()[0]!['prompt_version_id']).toBe('ver-123');
  });

  it('never sends prompt_version_id to a BYO provider', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(PLAIN_COMPLETION))
      .mockResolvedValue(jsonResponse({ traceId: 'tr-1' }));

    await hub.gateway.runPromptWithTools(renderResult(), {
      provider: { baseUrl: 'https://localhost/v1', apiKey: 'pk' },
    });

    const providerCall = calls().find(([url]) => url.includes('localhost/v1'))!;
    expect(bodyOf(providerCall[1])).not.toHaveProperty('prompt_version_id');
  });

  it("stamps the render's versionId on the trace without the caller restating it", async () => {
    // A BYO provider makes the SDK write the llm span itself, so the span this test needs
    // to inspect travels in a request body.
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(PLAIN_COMPLETION))
      .mockResolvedValueOnce(jsonResponse({ traceId: 'tr-1' }));

    await hub.gateway.runPromptWithTools(renderResult(), {
      provider: { baseUrl: 'https://localhost/v1', apiKey: 'pk' },
    });
    await hub.gateway.flush();

    const traceCall = calls().find(([url]) => url.includes('/traces'))!;
    const traces = bodyOf(traceCall[1]) as { traces: { spans: { promptVersionId?: string }[] }[] };
    expect(traces.traces[0]!.spans[0]!.promptVersionId).toBe('ver-123');
  });

  it('sends a pinned binding as a pin, not as its alias', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ data: [resolvedTool('get_weather', 'client', 2)] }))
      .mockResolvedValueOnce(jsonResponse(PLAIN_COMPLETION));

    await hub.gateway.runPromptWithTools(
      renderResult({
        toolResolutions: [
          { name: 'get_weather', pinnedVersionNumber: 2, versionNumber: 2, source: 'alias' },
        ],
      }),
      { dispatch: () => 'x' },
    );

    expect(bodyOf(calls()[0]![1])).toEqual({ refs: [{ name: 'get_weather', version: 2 }] });
    expect(chatBodies()[0]!['tool_refs']).toEqual([{ name: 'get_weather', version: 2 }]);
  });

  it('names both fixes when the version has no bound model and none was passed', async () => {
    await expect(hub.gateway.runPromptWithTools(renderResult({ model: null }))).rejects.toThrow(
      /bind a default model.*or pass model/s,
    );
  });

  it('lets an explicitly passed model win over the bound one', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(PLAIN_COMPLETION));
    await hub.gateway.runPromptWithTools(renderResult({ model: null }), { model: 'gpt-4o' });
    expect(chatBodies()[0]!['model']).toBe('gpt-4o');
  });

  it('runs a prompt with no tools as a plain completion', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(PLAIN_COMPLETION));

    const result = await hub.gateway.runPromptWithTools(renderResult());

    expect(result.content).toBe('Sunny.');
    expect(calls().some(([url]) => url.includes('/tools/resolve'))).toBe(false);
  });

  it('still raises MISSING_DISPATCH when nothing can run a bound client tool', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: [resolvedTool('get_weather')] }));

    await expect(
      hub.gateway.runPromptWithTools(
        renderResult({
          toolResolutions: [
            { name: 'get_weather', alias: 'production', versionNumber: 4, source: 'alias' },
          ],
        }),
      ),
    ).rejects.toThrow(/no implementation was supplied|has no implementation/);
  });

  describe('streaming', () => {
    /** One tool round then a streamed answer — the whole event contract in one test. */
    it('emits content, tool_call, tool_result and done', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse({ data: [resolvedTool('get_weather')] }))
        .mockResolvedValueOnce(
          sseResponse(
            [
              chunk({ content: 'Let me check.' }),
              chunk({ tool_calls: [{ index: 0, id: 'call-1', function: { name: 'get_weather' } }] }),
              chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
              chunk({ tool_calls: [{ index: 0, function: { arguments: '"Lisbon"}' } }] }),
              chunk({}, 'tool_calls'),
            ],
            { 'x-gateway-trace-id': 'tr-1', 'x-gateway-span-id': 'span-1' },
          ),
        )
        .mockResolvedValueOnce(
          sseResponse([chunk({ content: 'Sunny ' }), chunk({ content: 'in Lisbon.' }), chunk({}, 'stop')], {
            'x-gateway-trace-id': 'tr-1',
            'x-gateway-span-id': 'span-2',
          }),
        )
        .mockResolvedValue(jsonResponse({ traceId: 'tr-1' }));

      const events: ToolLoopEvent[] = [];
      const stream = await hub.gateway.runPromptWithTools(
        renderResult({
          toolResolutions: [
            { name: 'get_weather', alias: 'production', versionNumber: 4, source: 'alias' },
          ],
        }),
        {
          stream: true,
          dispatch: (_name, args) => ({ tempC: 21, city: args['city'] }),
        },
      );
      for await (const event of stream) events.push(event);

      expect(events.map((e) => e.type)).toEqual([
        'content', 'tool_call', 'tool_result', 'content', 'content', 'done',
      ]);
      const [first, call, toolResult, , , done] = events;
      expect(first).toMatchObject({ type: 'content', delta: 'Let me check.', round: 0 });
      // Reassembled from four separate frames.
      expect(call).toMatchObject({
        type: 'tool_call', name: 'get_weather', arguments: { city: 'Lisbon' }, round: 0,
      });
      expect(toolResult).toMatchObject({
        type: 'tool_result', name: 'get_weather', result: { tempC: 21, city: 'Lisbon' }, round: 0,
      });
      expect(done).toMatchObject({ type: 'done' });
      if (done?.type !== 'done') throw new Error('unreachable');
      expect(done.result.content).toBe('Sunny in Lisbon.');
      expect(done.result.iterations).toBe(2);
      expect(done.result.traceId).toBe('tr-1');

      const bodies = chatBodies();
      expect(bodies.every((b) => b['stream'] === true)).toBe(true);
      expect((bodies[1]!['messages'] as unknown[]).at(-1)).toEqual({
        role: 'tool',
        tool_call_id: 'call-1',
        content: '{"tempC":21,"city":"Lisbon"}',
      });
    });

    it('keeps every round on one trace and parents the tool span onto the round', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse({ data: [resolvedTool('get_weather')] }))
        .mockResolvedValueOnce(
          sseResponse(
            [
              chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_weather', arguments: '{}' } }] }),
              chunk({}, 'tool_calls'),
            ],
            { 'x-gateway-trace-id': 'tr-1', 'x-gateway-span-id': 'span-1' },
          ),
        )
        .mockResolvedValueOnce(
          sseResponse([chunk({ content: 'ok' }), chunk({}, 'stop')], {
            'x-gateway-trace-id': 'tr-1',
            'x-gateway-span-id': 'span-2',
          }),
        )
        .mockResolvedValue(jsonResponse({ traceId: 'tr-1' }));

      const stream = await hub.gateway.runPromptWithTools(
        renderResult({
          toolResolutions: [
            { name: 'get_weather', alias: 'production', versionNumber: 4, source: 'alias' },
          ],
        }),
        { stream: true, dispatch: () => '21C' },
      );
      for await (const _ of stream) { /* drain */ }
      await hub.gateway.flush();

      const chatCalls = calls().filter(([url]) => url.includes('/gateway/chat/completions'));
      const headersOf = (init: RequestInit) => init.headers as Record<string, string>;
      // Round 1 has no trace to join yet; round 2 joins the one the gateway minted.
      expect(headersOf(chatCalls[0]![1])['x-trace-id']).toBeUndefined();
      expect(headersOf(chatCalls[0]![1])['x-trace-name']).toBe('runToolLoop');
      expect(headersOf(chatCalls[1]![1])['x-trace-id']).toBe('tr-1');

      const traceBodies = calls()
        .filter(([url]) => url.includes('/traces'))
        .map(([, init]) => bodyOf(init) as { traces: { traceId?: string; spans: Record<string, unknown>[] }[] });
      const toolSpans = traceBodies.flatMap((b) => b.traces).flatMap((t) => t.spans).filter((s) => s['kind'] === 'tool');
      expect(toolSpans).toHaveLength(1);
      expect(toolSpans[0]).toMatchObject({ name: 'get_weather', parentSpanId: 'span-1', output: '21C' });
      expect(traceBodies.flatMap((b) => b.traces).every((t) => t.traceId === 'tr-1')).toBe(true);
    });

    it('reports a failing tool as an error event, then rethrows', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse({ data: [resolvedTool('get_weather')] }))
        .mockResolvedValueOnce(
          sseResponse(
            [
              chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_weather', arguments: '{}' } }] }),
              chunk({}, 'tool_calls'),
            ],
            { 'x-gateway-trace-id': 'tr-1', 'x-gateway-span-id': 'span-1' },
          ),
        )
        .mockResolvedValue(jsonResponse({ traceId: 'tr-1' }));

      const events: ToolLoopEvent[] = [];
      const stream = await hub.gateway.runPromptWithTools(
        renderResult({
          toolResolutions: [
            { name: 'get_weather', alias: 'production', versionNumber: 4, source: 'alias' },
          ],
        }),
        {
          stream: true,
          dispatch: () => {
            throw new Error('upstream is down');
          },
        },
      );

      await expect(
        (async () => {
          for await (const event of stream) events.push(event);
        })(),
      ).rejects.toThrow('upstream is down');

      const last = events.at(-1)!;
      expect(last).toMatchObject({ type: 'tool_result', error: 'upstream is down' });
      if (last.type !== 'tool_result') throw new Error('unreachable');
      expect(last.result).toBeUndefined();
    });

    it('stops at maxIterations without hanging', async () => {
      const toolRound = () =>
        sseResponse(
          [
            chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_weather', arguments: '{}' } }] }),
            chunk({}, 'tool_calls'),
          ],
          { 'x-gateway-trace-id': 'tr-1', 'x-gateway-span-id': 'span-1' },
        );
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse({ data: [resolvedTool('get_weather')] }))
        .mockResolvedValueOnce(toolRound())
        .mockResolvedValueOnce(toolRound())
        .mockResolvedValue(jsonResponse({ traceId: 'tr-1' }));

      const events: ToolLoopEvent[] = [];
      const stream = await hub.gateway.runPromptWithTools(
        renderResult({
          toolResolutions: [
            { name: 'get_weather', alias: 'production', versionNumber: 4, source: 'alias' },
          ],
        }),
        { stream: true, maxIterations: 2, dispatch: () => '21C' },
      );
      for await (const event of stream) events.push(event);

      const done = events.at(-1)!;
      expect(done.type).toBe('done');
      if (done.type !== 'done') throw new Error('unreachable');
      expect(done.result.stoppedAtLimit).toBe(true);
      expect(done.result.iterations).toBe(2);
      expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(2);
    });

    it('streams straight from runToolLoop too, not only from the render shortcut', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        sseResponse([chunk({ content: 'hi' }), chunk({}, 'stop')], {
          'x-gateway-trace-id': 'tr-9',
          'x-gateway-span-id': 'span-1',
        }),
      );

      const events: ToolLoopEvent[] = [];
      const stream = await hub.gateway.runToolLoop({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      for await (const event of stream) events.push(event);

      expect(events.map((e) => e.type)).toEqual(['content', 'done']);
      const done = events[1]!;
      if (done.type !== 'done') throw new Error('unreachable');
      expect(done.result.content).toBe('hi');
    });
  });

  /**
   * `clientTools` exists so the catalog keeps a tool's definition while the caller supplies
   * only its implementation. These tests assert on what does NOT happen as much as on what
   * does: no /tools/sync request, the binding's own ref, the catalog's version stamp.
   */
  describe('clientTools', () => {
    const asksFor = (name: string, args: Record<string, unknown>) => ({
      id: 'chatcmpl-1',
      model: 'gpt-4o-mini',
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
                index: 0,
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });

    const clientBinding = (name = 'search_flights') =>
      renderResult({
        toolResolutions: [{ name, alias: 'production', versionNumber: 4, source: 'alias' }],
      });

    it('runs the mapped function and writes nothing to the catalog', async () => {
      const seen: Record<string, unknown>[] = [];
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse({ data: [resolvedTool('search_flights')] }))
        .mockResolvedValueOnce(
          jsonResponse(asksFor('search_flights', { origin: 'LHE', destination: 'IST' }), {
            'x-gateway-trace-id': 'tr-1',
            'x-gateway-span-id': 'llm-1',
          }),
        )
        .mockResolvedValue(jsonResponse(PLAIN_COMPLETION, { 'x-gateway-trace-id': 'tr-1' }));

      const result = await hub.gateway.runPromptWithTools(clientBinding(), {
        clientTools: {
          search_flights: (args) => {
            seen.push(args);
            return { cheapest_usd: 240 };
          },
        },
      });

      expect(result.content).toBe('Sunny.');
      expect(seen).toEqual([{ origin: 'LHE', destination: 'IST' }]);
      expect(calls().some(([url]) => url.includes('/tools/resolve'))).toBe(true);
      expect(calls().some(([url]) => url.includes('/tools/sync'))).toBe(false);
    });

    it("keeps the binding's alias and stamps the catalog version on the tool span", async () => {
      // `tools: [fn], sync: false` loses both of these — that is why this option exists.
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse({ data: [resolvedTool('search_flights', 'client', 7)] }))
        .mockResolvedValueOnce(
          jsonResponse(asksFor('search_flights', { origin: 'LHE' }), {
            'x-gateway-trace-id': 'tr-1',
            'x-gateway-span-id': 'llm-1',
          }),
        )
        .mockResolvedValue(jsonResponse(PLAIN_COMPLETION, { 'x-gateway-trace-id': 'tr-1' }));

      await hub.gateway.runPromptWithTools(clientBinding(), {
        clientTools: { search_flights: () => 'PK-709' },
      });
      await hub.gateway.flush();

      expect(chatBodies()[0]!['tool_refs']).toEqual([
        { name: 'search_flights', alias: 'production' },
      ]);
      const traceCall = calls().find(([url]) => url.includes('/traces'))!;
      const body = bodyOf(traceCall[1]) as {
        traces: { spans: { kind: string; attributes?: Record<string, unknown> }[] }[];
      };
      const toolSpans = body.traces.flatMap((t) => t.spans).filter((sp) => sp.kind === 'tool');
      expect(toolSpans.map((sp) => sp.attributes?.['toolVersionId'])).toEqual(['tool-1:7']);
    });

    it('names the keys it was given when a bound client tool has no runner', async () => {
      // The keys that WERE supplied are what make a typo a one-second fix.
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse({ data: [resolvedTool('search_flights')] }),
      );

      await expect(
        hub.gateway.runPromptWithTools(clientBinding(), {
          clientTools: { search_flight: () => 'x' },
        }),
      ).rejects.toThrow(/search_flights.*clientTools held: \['search_flight'\]/s);
    });

    it('silently ignores an http tool that is named in the map', async () => {
      // One map serves both aliases of a tool: production http, staging client. Our own
      // guide script passes exactly that, so a warning here would fire on correct runs.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          jsonResponse({ data: [resolvedTool('get_city_weather', 'http')] }),
        )
        .mockResolvedValueOnce(
          jsonResponse(asksFor('get_city_weather', { city: 'Lahore' }), {
            'x-gateway-trace-id': 'tr-1',
            'x-gateway-span-id': 'llm-1',
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            result: { tempC: 31 },
            status: 200,
            latencyMs: 12,
            toolVersionId: 'tool-1:4',
          }),
        )
        .mockResolvedValue(jsonResponse(PLAIN_COMPLETION, { 'x-gateway-trace-id': 'tr-1' }));

      const result = await hub.gateway.runPromptWithTools(clientBinding('get_city_weather'), {
        clientTools: { get_city_weather: () => 'unused' },
      });

      expect(result.content).toBe('Sunny.');
      expect(warn).not.toHaveBeenCalled();
      // The platform ran it, not the supplied function.
      expect(calls().some(([url]) => url.includes('/execute'))).toBe(true);
      warn.mockRestore();
    });

    it('works on the streaming path too', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse({ data: [resolvedTool('search_flights')] }))
        .mockResolvedValueOnce(
          sseResponse(
            [
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-1',
                    function: { name: 'search_flights', arguments: '{"origin":"LHE"}' },
                  },
                ],
              }),
              chunk({}, 'tool_calls'),
            ],
            { 'x-gateway-trace-id': 'tr-1', 'x-gateway-span-id': 'llm-1' },
          ),
        )
        .mockResolvedValue(
          sseResponse([chunk({ content: 'Cheapest is PK-709.' }), chunk({}, 'stop')], {
            'x-gateway-trace-id': 'tr-1',
            'x-gateway-span-id': 'llm-2',
          }),
        );

      const ran: unknown[] = [];
      const events: ToolLoopEvent[] = [];
      const stream = await hub.gateway.runPromptWithTools(clientBinding(), {
        stream: true,
        clientTools: {
          search_flights: (args) => {
            ran.push(args);
            return 'PK-709';
          },
        },
      });
      for await (const event of stream) events.push(event);

      expect(ran).toEqual([{ origin: 'LHE' }]);
      expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result', 'content', 'done']);
    });

    it('lets a declared tool of the same name win', async () => {
      // Precedence: `tools` owns the definition, so it must also own the execution.
      const which: string[] = [];
      const declared = acrux.tool(
        { name: 'search_flights', description: 'Search flights.', parameters: { origin: 'string' } },
        () => {
          which.push('declared');
          return 'PK-709';
        },
      );

      vi.mocked(fetch)
        .mockResolvedValueOnce(
          jsonResponse({ toolId: 'tool-1', versionNumber: 1, committed: true, alias: 'production' }),
        )
        .mockResolvedValueOnce(jsonResponse({ data: [resolvedTool('search_flights')] }))
        .mockResolvedValueOnce(
          jsonResponse(asksFor('search_flights', { origin: 'LHE' }), {
            'x-gateway-trace-id': 'tr-1',
            'x-gateway-span-id': 'llm-1',
          }),
        )
        .mockResolvedValue(jsonResponse(PLAIN_COMPLETION, { 'x-gateway-trace-id': 'tr-1' }));

      await hub.gateway.runPromptWithTools(clientBinding(), {
        tools: [declared],
        clientTools: {
          search_flights: () => {
            which.push('mapped');
            return 'PK-999';
          },
        },
      });

      expect(which).toEqual(['declared']);
    });
  });
});
