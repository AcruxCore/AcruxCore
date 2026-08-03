import { getAdapter } from './adapter';
import type { StreamChunk } from './types';

/** Build a mock streaming fetch Response whose body emits the given SSE frames. */
function sseResponse(frames: string[], status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Drain an async iterable of StreamChunk into an array. */
async function collect(it: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

afterEach(() => jest.restoreAllMocks());

describe('OpenAiAdapter.streamChatCompletion', () => {
  it('yields deltas then a final usage chunk from provider SSE', async () => {
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(frames));

    const adapter = getAdapter('openai');
    const chunks = await collect(
      adapter.streamChatCompletion(
        { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
        { apiKey: 'sk-test' },
      ),
    );

    // Request mapping: stream:true + stream_options.include_usage
    const sentBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.stream).toBe(true);
    expect(sentBody.stream_options).toEqual({ include_usage: true });

    // Concatenated deltas equal the full message.
    expect(chunks.map((c) => c.delta).join('')).toBe('Hello');
    expect(chunks.some((c) => c.finish_reason === 'stop')).toBe(true);
    const final = chunks.find((c) => c.usage);
    expect(final?.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  it('throws ProviderError before the first chunk on a non-2xx response', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{"error":{"message":"boom"}}', { status: 500 }));
    const adapter = getAdapter('openai');
    await expect(
      collect(
        adapter.streamChatCompletion(
          { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
          { apiKey: 'sk-test' },
        ),
      ),
    ).rejects.toMatchObject({ status: 500, retriable: true });
  });

  it('surfaces tool_calls deltas (partial across frames) instead of dropping tool-call-only frames', async () => {
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\""}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"Paris\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
      'data: [DONE]\n\n',
    ];
    jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(frames));

    const adapter = getAdapter('openai');
    const chunks = await collect(
      adapter.streamChatCompletion(
        { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'weather?' }] },
        { apiKey: 'sk-test' },
      ),
    );

    // Tool-call-only frames are NOT dropped as empty keep-alives.
    const toolChunks = chunks.filter((c) => c.tool_calls);
    expect(toolChunks).toHaveLength(3);
    expect(toolChunks[0]?.tool_calls?.[0]).toMatchObject({ id: 'call_1', type: 'function', function: { name: 'get_weather' } });
    // Partial deltas (id/name absent on later frames) map to empty-string defaults, not undefined.
    expect(toolChunks[1]?.tool_calls?.[0]).toMatchObject({ id: '', function: { name: '' } });
    expect(chunks.some((c) => c.finish_reason === 'tool_calls')).toBe(true);
  });

  it('preserves the wire index so two parallel tool calls interleaving across frames stay correlated', async () => {
    const frames = [
      // Frame 1: call 0 starts (get_weather).
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
      // Frame 2: call 1 starts (get_time), interleaved before call 0 finishes.
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"get_time","arguments":""}}]},"finish_reason":null}]}\n\n',
      // Frame 3: call 0 continues with argument fragment.
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Paris\\"}"}}]},"finish_reason":null}]}\n\n',
      // Frame 4: call 1 continues with a different argument fragment.
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"tz\\":\\"UTC\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(frames));

    const adapter = getAdapter('openai');
    const chunks = await collect(
      adapter.streamChatCompletion(
        { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'weather and time?' }] },
        { apiKey: 'sk-test' },
      ),
    );

    const toolChunks = chunks.filter((c) => c.tool_calls);
    expect(toolChunks).toHaveLength(4);

    // Each mapped tool_calls[].index correctly identifies which parallel call the fragment belongs to.
    expect(toolChunks[0]?.tool_calls?.[0]).toMatchObject({ index: 0, id: 'call_1', function: { name: 'get_weather' } });
    expect(toolChunks[1]?.tool_calls?.[0]).toMatchObject({ index: 1, id: 'call_2', function: { name: 'get_time' } });
    expect(toolChunks[2]?.tool_calls?.[0]).toMatchObject({ index: 0, function: { arguments: '{"city":"Paris"}' } });
    expect(toolChunks[3]?.tool_calls?.[0]).toMatchObject({ index: 1, function: { arguments: '{"tz":"UTC"}' } });

    // Reassembling by index (not by array position) correctly separates the two calls' arguments.
    const argsByIndex = new Map<number, string>();
    for (const c of toolChunks) {
      for (const tc of c.tool_calls ?? []) {
        argsByIndex.set(tc.index as number, (argsByIndex.get(tc.index as number) ?? '') + tc.function.arguments);
      }
    }
    expect(argsByIndex.get(0)).toBe('{"city":"Paris"}');
    expect(argsByIndex.get(1)).toBe('{"tz":"UTC"}');
  });
});

describe('AnthropicAdapter.streamChatCompletion', () => {
  it('maps the /v1/messages event stream to StreamChunks with usage', async () => {
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(frames));

    const adapter = getAdapter('anthropic');
    const chunks = await collect(
      adapter.streamChatCompletion(
        {
          model: 'claude-3-5-sonnet-latest',
          messages: [
            { role: 'system', content: 'Be terse.' },
            { role: 'user', content: 'hi' },
          ],
          max_tokens: 64,
        },
        { apiKey: 'ak-test' },
      ),
    );

    // Request mapping: system extracted, stream:true, x-api-key + version header.
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.stream).toBe(true);
    expect(sentBody.system).toBe('Be terse.');
    expect(sentBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('ak-test');
    expect((init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');

    // Deltas concatenate; final frame carries mapped finish_reason + usage.
    expect(chunks.map((c) => c.delta).join('')).toBe('Hello');
    const final = chunks.find((c) => c.finish_reason !== null);
    expect(final?.finish_reason).toBe('stop'); // end_turn → stop
    expect(final?.usage).toEqual({ prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 });
  });

  it('surfaces tool_use content_block_start/input_json_delta events as tool_calls deltas', async () => {
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\"Paris\\"}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(frames));

    const adapter = getAdapter('anthropic');
    const chunks = await collect(
      adapter.streamChatCompletion(
        {
          model: 'claude-3-5-sonnet-latest',
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
        },
        { apiKey: 'ak-test' },
      ),
    );

    const toolChunks = chunks.filter((c) => c.tool_calls);
    expect(toolChunks).toHaveLength(3);
    // content_block_start carries the call's id/name/tool-call ordinal.
    expect(toolChunks[0]?.tool_calls?.[0]).toMatchObject({ index: 0, id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '' } });
    // input_json_delta fragments stream the arguments in afterward.
    expect(toolChunks[1]?.tool_calls?.[0]).toMatchObject({ index: 0, id: '', function: { name: '', arguments: '{"city"' } });
    expect(toolChunks[2]?.tool_calls?.[0]).toMatchObject({ index: 0, id: '', function: { name: '', arguments: ':"Paris"}' } });
    // tool_use → tool_calls finish_reason, still surfaced on the final frame.
    const final = chunks.find((c) => c.finish_reason !== null);
    expect(final?.finish_reason).toBe('tool_calls');
  });

  it('preserves the tool-call ordinal so two parallel tool_use blocks interleaving across events stay correlated', async () => {
    const frames = [
      // Block 0 (get_weather) starts.
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}\n\n',
      // Block 1 (get_time) starts, interleaved before block 0 finishes.
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"get_time","input":{}}}\n\n',
      // Block 0 continues with an argument fragment.
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Paris\\"}"}}\n\n',
      // Block 1 continues with a different argument fragment.
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"tz\\":\\"UTC\\"}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
    ];
    jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(frames));

    const adapter = getAdapter('anthropic');
    const chunks = await collect(
      adapter.streamChatCompletion(
        {
          model: 'claude-3-5-sonnet-latest',
          messages: [{ role: 'user', content: 'weather and time?' }],
          tools: [
            { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
            { type: 'function', function: { name: 'get_time', parameters: { type: 'object' } } },
          ],
        },
        { apiKey: 'ak-test' },
      ),
    );

    const toolChunks = chunks.filter((c) => c.tool_calls);
    expect(toolChunks).toHaveLength(4);
    expect(toolChunks[0]?.tool_calls?.[0]).toMatchObject({ index: 0, id: 'toolu_1', function: { name: 'get_weather' } });
    expect(toolChunks[1]?.tool_calls?.[0]).toMatchObject({ index: 1, id: 'toolu_2', function: { name: 'get_time' } });
    expect(toolChunks[2]?.tool_calls?.[0]).toMatchObject({ index: 0, function: { arguments: '{"city":"Paris"}' } });
    expect(toolChunks[3]?.tool_calls?.[0]).toMatchObject({ index: 1, function: { arguments: '{"tz":"UTC"}' } });

    // Reassembling by index (not array position) correctly separates the two calls.
    const argsByIndex = new Map<number, string>();
    for (const c of toolChunks) {
      for (const tc of c.tool_calls ?? []) {
        argsByIndex.set(tc.index as number, (argsByIndex.get(tc.index as number) ?? '') + tc.function.arguments);
      }
    }
    expect(argsByIndex.get(0)).toBe('{"city":"Paris"}');
    expect(argsByIndex.get(1)).toBe('{"tz":"UTC"}');
  });

  it('emits tool_calls[].index as a 0-based tool-call ordinal, not the raw content-block index, when text precedes the tool call', async () => {
    const frames = [
      // Content block 0 is TEXT, not a tool call — Anthropic's own content-block
      // index for the tool_use below is 1, but it is still the FIRST (and only)
      // tool call, so our canonical index must be 0, matching OpenAI's semantics
      // ("position among parallel tool calls"), not Anthropic's raw block position.
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check."}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Paris\\"}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
    ];
    jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(frames));

    const adapter = getAdapter('anthropic');
    const chunks = await collect(
      adapter.streamChatCompletion(
        {
          model: 'claude-3-5-sonnet-latest',
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
        },
        { apiKey: 'ak-test' },
      ),
    );

    const toolChunks = chunks.filter((c) => c.tool_calls);
    expect(toolChunks).toHaveLength(2);
    // Anthropic's raw content-block index for this call is 1 (block 0 was text),
    // but the canonical tool-call ordinal must be 0 — the first and only tool call.
    expect(toolChunks[0]?.tool_calls?.[0]).toMatchObject({ index: 0, id: 'toolu_1', function: { name: 'get_weather' } });
    expect(toolChunks[1]?.tool_calls?.[0]).toMatchObject({ index: 0, function: { arguments: '{"city":"Paris"}' } });
  });

  describe('response_format translation', () => {
    it('translates response_format into a forced tool call in the streaming payload', async () => {
      const frames = [
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n',
      ];
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(frames));

      const adapter = getAdapter('anthropic');
      await collect(
        adapter.streamChatCompletion(
          {
            model: 'claude-3-5-sonnet-latest',
            messages: [{ role: 'user', content: 'hi' }],
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'answer', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
            },
          },
          { apiKey: 'ak-test' },
        ),
      );

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const sentBody = JSON.parse(init.body as string);
      expect(sentBody.tools).toEqual([
        { name: 'answer', description: expect.any(String), input_schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
      ]);
      expect(sentBody.tool_choice).toEqual({ type: 'tool', name: 'answer' });
    });

    it('re-emits the forced tool-call input_json_delta fragments as plain content deltas, never as tool_calls', async () => {
      const frames = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"answer","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"ok\\""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":true}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
      ];
      jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(frames));

      const adapter = getAdapter('anthropic');
      const chunks = await collect(
        adapter.streamChatCompletion(
          {
            model: 'claude-3-5-sonnet-latest',
            messages: [{ role: 'user', content: 'hi' }],
            response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } },
          },
          { apiKey: 'ak-test' },
        ),
      );

      // The synthetic tool call must stay invisible to the caller: no tool_calls chunks at all.
      expect(chunks.some((c) => c.tool_calls)).toBe(false);
      // Concatenated content deltas reconstruct the complete JSON string.
      expect(chunks.map((c) => c.delta).join('')).toBe('{"ok":true}');
      // A forced-tool stop (stop_reason 'tool_use') reads as a normal completion, not tool_calls.
      const final = chunks.find((c) => c.finish_reason !== null);
      expect(final?.finish_reason).toBe('stop');
    });

    it('suppresses a stray text_delta that precedes the forced tool_use block, so no text chunk lands ahead of the JSON', async () => {
      // Regression: a model occasionally emits a stray text content block before the
      // forced tool_use block. Without suppression that text_delta would be yielded
      // as a normal content chunk, concatenating ahead of the JSON re-emitted from
      // the tool's input_json_delta fragments and breaking a caller's JSON.parse.
      const frames = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Sure, here is the answer: "}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"answer","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"ok\\":true}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
      ];
      jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(frames));

      const adapter = getAdapter('anthropic');
      const chunks = await collect(
        adapter.streamChatCompletion(
          {
            model: 'claude-3-5-sonnet-latest',
            messages: [{ role: 'user', content: 'hi' }],
            response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } },
          },
          { apiKey: 'ak-test' },
        ),
      );

      // No tool_calls chunks (mechanism invisible to the caller) AND no stray text ahead
      // of the JSON — only the forced tool's JSON content survives, concatenating cleanly.
      expect(chunks.some((c) => c.tool_calls)).toBe(false);
      expect(chunks.map((c) => c.delta).join('')).toBe('{"ok":true}');
    });

    it('flushes suppressed text as a fallback when the model disobeys the forced tool call (mirrors the non-streaming path)', async () => {
      // Regression: if the model ignores the forced tool_choice and returns plain text
      // instead of calling the synthetic structured_output tool, the non-streaming path
      // returns that text (its `formatBlock` lookup misses, so it falls through). The
      // streaming path must match — without this fallback it suppressed every text_delta
      // (forcedFormatTool set) and handed the caller an empty content stream.
      const frames = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I cannot return a tool call here."}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
      ];
      jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(frames));

      const adapter = getAdapter('anthropic');
      const chunks = await collect(
        adapter.streamChatCompletion(
          {
            model: 'claude-3-5-sonnet-latest',
            messages: [{ role: 'user', content: 'hi' }],
            response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } },
          },
          { apiKey: 'ak-test' },
        ),
      );

      // No tool_calls (the synthetic tool was never called) and the model's text survives
      // instead of being silently dropped — finish_reason reads as a normal completion.
      expect(chunks.some((c) => c.tool_calls)).toBe(false);
      expect(chunks.map((c) => c.delta).join('')).toBe('I cannot return a tool call here.');
      const final = chunks.find((c) => c.finish_reason !== null);
      expect(final?.finish_reason).toBe('stop');
    });
  });
});

describe('GeminiAdapter.streamChatCompletion', () => {
  it('maps the :streamGenerateContent SSE stream to StreamChunks with usage', async () => {
    const frames = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}],"role":"model"},"index":0}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}],"role":"model"},"index":0}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":""}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":6,"candidatesTokenCount":2,"totalTokenCount":8}}\n\n',
    ];
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(frames));

    const adapter = getAdapter('gemini');
    const chunks = await collect(
      adapter.streamChatCompletion(
        {
          model: 'gemini-1.5-flash',
          messages: [
            { role: 'system', content: 'Be terse.' },
            { role: 'user', content: 'hi' },
          ],
        },
        { apiKey: 'g-key' },
      ),
    );

    // Request mapping: streamGenerateContent?alt=sse, x-goog-api-key, system hoisted.
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse',
    );
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.systemInstruction).toEqual({ parts: [{ text: 'Be terse.' }] });
    expect(sentBody.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);

    // Deltas concatenate; final frame carries mapped finish_reason + usage.
    expect(chunks.map((c) => c.delta).join('')).toBe('Hello');
    const final = chunks.find((c) => c.finish_reason !== null);
    expect(final?.finish_reason).toBe('stop'); // STOP → stop
    expect(final?.usage).toEqual({ prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 });
  });

  it('surfaces functionCall parts as tool_calls deltas, forcing finish_reason to tool_calls', async () => {
    const frames = [
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":8}}\n\n',
    ];
    jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(frames));

    const adapter = getAdapter('gemini');
    const chunks = await collect(
      adapter.streamChatCompletion(
        {
          model: 'gemini-1.5-flash',
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
        },
        { apiKey: 'g-key' },
      ),
    );

    const toolChunks = chunks.filter((c) => c.tool_calls);
    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0]?.tool_calls?.[0]).toMatchObject({
      index: 0,
      id: 'get_weather',
      type: 'function',
      function: { name: 'get_weather' },
    });
    expect(JSON.parse(toolChunks[0]?.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({ city: 'Paris' });
    // Gemini's own finishReason is STOP even for a function-calling turn — we force
    // 'tool_calls' when the frame carries a functionCall, matching OpenAI/Anthropic
    // semantics (finish_reason reflects WHY the turn ended, and tool-calling ended it).
    expect(chunks.some((c) => c.finish_reason === 'tool_calls')).toBe(true);
  });

  it('preserves the 0-based ordinal among tool-call parts when a candidate yields two parallel functionCall parts in one frame', async () => {
    const frames = [
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}},{"functionCall":{"name":"get_time","args":{"tz":"UTC"}}}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":4,"totalTokenCount":9}}\n\n',
    ];
    jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse(frames));

    const adapter = getAdapter('gemini');
    const chunks = await collect(
      adapter.streamChatCompletion(
        {
          model: 'gemini-1.5-flash',
          messages: [{ role: 'user', content: 'weather and time?' }],
          tools: [
            { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
            { type: 'function', function: { name: 'get_time', parameters: { type: 'object' } } },
          ],
        },
        { apiKey: 'g-key' },
      ),
    );

    const toolChunks = chunks.filter((c) => c.tool_calls);
    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0]?.tool_calls).toHaveLength(2);
    expect(toolChunks[0]?.tool_calls?.[0]).toMatchObject({ index: 0, id: 'get_weather', function: { name: 'get_weather' } });
    expect(toolChunks[0]?.tool_calls?.[1]).toMatchObject({ index: 1, id: 'get_time', function: { name: 'get_time' } });
  });
});
