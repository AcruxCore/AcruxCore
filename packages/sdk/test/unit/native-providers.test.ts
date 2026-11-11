/**
 * BYO calls in the native Anthropic and Gemini formats. The provider is the one thing
 * replaced (a paid third party): `fetch` is stubbed to record each request and answer with
 * the provider's real wire shape. Body building, translation, the tool loop and span
 * reporting are the SDK's real code. Mirrors the Python `test_native_providers.py`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { acruxcore } from '../../src/client';
import { acruxcoreError } from '../../src/error';
import type { ProviderConfig, ToolDefinition } from '../../src/types';

const WEATHER: ToolDefinition[] = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
}];
const ANTHROPIC: ProviderConfig = { kind: 'anthropic', apiKey: 'sk-ant' };
const GEMINI: ProviderConfig = { kind: 'gemini', apiKey: 'g-key' };

type Json = Record<string, unknown>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sse(events: Json[], opts: { named: boolean; crlf?: boolean }): Response {
  const nl = opts.crlf ? '\r\n' : '\n';
  const text = events
    .map((e) => `${opts.named ? `event: ${String(e['type'])}${nl}` : ''}data: ${JSON.stringify(e)}${nl}${nl}`)
    .join('');
  return new Response(new TextEncoder().encode(text), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Stubs fetch; `reply(url, body, index)` answers each provider call, and /traces posts are collected. */
function stub(reply: (url: string, body: Json, i: number) => Response) {
  const calls: { url: string; headers: Record<string, string>; body: Json }[] = [];
  const traces: Json[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Json;
    if (url.endsWith('/traces')) {
      traces.push(...(body['traces'] as Json[]));
      return json({ data: [] });
    }
    calls.push({ url, headers: init?.headers as Record<string, string>, body });
    return reply(url, body, calls.length - 1);
  });
  return { calls, traces };
}

const hub = () => new acruxcore({ apiKey: 'acx', baseUrl: 'http://localhost:3000/api/v1', maxRetries: 0 });

afterEach(() => vi.restoreAllMocks());

describe('BYO Anthropic (native Messages API)', () => {
  it('sends the Messages API and reads its reply, cache reads added back into promptTokens', async () => {
    const { calls } = stub(() => json({
      id: 'msg_1', model: 'claude-haiku-4-5', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hello.' }],
      usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 90 },
    }));
    const r = await hub().gateway.chat({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }],
      provider: ANTHROPIC, trace: false, temperature: 0,
    });
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers['x-api-key']).toBe('sk-ant');
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0].headers['Authorization']).toBeUndefined();
    expect(calls[0].body).toEqual({
      model: 'claude-haiku-4-5', system: 'Be brief.', max_tokens: 1024, temperature: 0,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.content).toBe('Hello.');
    expect(r.finishReason).toBe('stop');
    expect(r.usage).toMatchObject({ promptTokens: 100, completionTokens: 3, cachedTokens: 90 });
    expect(r.gateway.provider).toBe('api.anthropic.com');
  });

  it('runs a tool loop and sends parallel results back in one user turn', async () => {
    const replies = [
      { id: 'm1', model: 'claude', stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 },
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
          { type: 'tool_use', id: 'tu_2', name: 'get_weather', input: { city: 'Rome' } },
        ] },
      { id: 'm2', model: 'claude', stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 4 },
        content: [{ type: 'text', text: 'Paris 18, Rome 24.' }] },
    ];
    const { calls } = stub((_u, _b, i) => json(replies[i]));
    const r = await hub().gateway.runToolLoop({
      model: 'claude', messages: [{ role: 'user', content: 'weather?' }], toolDefs: WEATHER,
      dispatch: (_name, args) => ({ temp: (args as { city: string }).city === 'Paris' ? 18 : 24 }),
      provider: ANTHROPIC, trace: false,
    });
    expect(r.content).toBe('Paris 18, Rome 24.');
    const second = calls[1].body['messages'] as Json[];
    expect(second[2]).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu_1', content: '{"temp":18}' },
      { type: 'tool_result', tool_use_id: 'tu_2', content: '{"temp":24}' },
    ] });
    expect(second).toHaveLength(3);
  });

  it('streams a tool loop from named SSE events and reports each round with usage', async () => {
    const rounds: Json[][] = [
      [
        { type: 'message_start', message: { id: 'm1', model: 'claude-x', usage: { input_tokens: 20 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_9', name: 'get_weather', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city": ' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Paris"}' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
        { type: 'message_stop' },
      ],
      [
        { type: 'message_start', message: { id: 'm2', model: 'claude-x', usage: { input_tokens: 40 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'It is 18C.' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ],
    ];
    const { calls, traces } = stub((_u, _b, i) => sse(rounds[i], { named: true }));
    const client = hub();
    const events = [];
    for await (const ev of await client.gateway.runToolLoop({
      model: 'claude-x', messages: [{ role: 'user', content: 'weather?' }], toolDefs: WEATHER,
      dispatch: () => ({ temp: 18 }), provider: ANTHROPIC, stream: true,
    })) events.push(ev);
    await client.gateway.flush();

    expect(calls[0].body['stream']).toBe(true);
    expect(calls[0].body['stream_options']).toBeUndefined();
    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls).toEqual([expect.objectContaining({ id: 'tu_9', arguments: { city: 'Paris' } })]);
    const done = events[events.length - 1];
    expect(done.type === 'done' && done.result.content).toBe('It is 18C.');
    const llm = traces.flatMap((t) => t['spans'] as Json[]).filter((s) => s['kind'] === 'llm');
    expect(llm.map((s) => s['usage'])).toEqual([
      { promptTokens: 20, completionTokens: 12, totalTokens: 32 },
      { promptTokens: 40, completionTokens: 5, totalTokens: 45 },
    ]);
  });

  it('sends responseFormat as a forced tool and returns its input as JSON content', async () => {
    const { calls } = stub(() => json({
      id: 'm', model: 'claude', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', id: 't', name: 'capital', input: { capital: 'Paris' } }],
    }));
    const r = await hub().gateway.chat({
      model: 'claude', messages: [{ role: 'user', content: 'France?' }], provider: ANTHROPIC, trace: false,
      responseFormat: { type: 'json_schema', json_schema: { name: 'capital', schema: { type: 'object' } } },
    });
    expect(calls[0].body['tool_choice']).toEqual({ type: 'tool', name: 'capital' });
    expect(JSON.parse(r.content ?? '')).toEqual({ capital: 'Paris' });
    expect(r.finishReason).toBe('stop');
  });
});

describe('BYO Gemini (native generateContent)', () => {
  it('sends the thought signature, call id and function name back on the next turn', async () => {
    const replies = [
      { responseId: 'r1', modelVersion: 'gemini-3.5-flash',
        candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [
          { functionCall: { id: 'call_1', name: 'get_weather', args: { city: 'Paris' } }, thoughtSignature: 'SIG1' },
          { functionCall: { id: 'call_2', name: 'get_weather', args: { city: 'Rome' } } },
        ] } }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 30, totalTokenCount: 90 } },
      { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Both mild.' }] } }] },
    ];
    const { calls } = stub((_u, _b, i) => json(replies[i]));
    const r = await hub().gateway.runToolLoop({
      model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'weather?' }], toolDefs: WEATHER,
      dispatch: () => ({ temp: 20 }), provider: GEMINI, trace: false,
    });
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent');
    expect(calls[0].headers['x-goog-api-key']).toBe('g-key');
    const contents = calls[1].body['contents'] as Json[];
    expect(contents[1]).toEqual({ role: 'model', parts: [
      { functionCall: { name: 'get_weather', args: { city: 'Paris' }, id: 'call_1' }, thoughtSignature: 'SIG1' },
      { functionCall: { name: 'get_weather', args: { city: 'Rome' }, id: 'call_2' } },
    ] });
    expect(contents[2]).toEqual({ role: 'user', parts: [
      { functionResponse: { name: 'get_weather', response: { temp: 20 }, id: 'call_1' } },
      { functionResponse: { name: 'get_weather', response: { temp: 20 }, id: 'call_2' } },
    ] });
    expect(r.content).toBe('Both mild.');
  });

  it('sends a tool schema as parametersJsonSchema, which accepts additionalProperties', async () => {
    // Gemini's `parameters` is an OpenAPI subset that 400s on `additionalProperties`,
    // which every zod-generated schema has. `parametersJsonSchema` takes full JSON Schema.
    const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
    const { calls } = stub(() => json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] }));
    await hub().gateway.chat({
      model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'weather?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: schema } }],
      provider: GEMINI, trace: false,
    });
    const decl = ((calls[0].body['tools'] as Json[])[0]['functionDeclarations'] as Json[])[0];
    expect(decl).toEqual({ name: 'get_weather', parametersJsonSchema: schema });
  });

  it('counts thinking as completion and leaves thought text out of the answer', async () => {
    stub(() => json({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'plan', thought: true }, { text: 'Answer.' }] } }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, thoughtsTokenCount: 40, cachedContentTokenCount: 4, totalTokenCount: 50 },
    }));
    const r = await hub().gateway.chat({ model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'q' }], provider: GEMINI, trace: false });
    expect(r.content).toBe('Answer.');
    expect(r.usage).toMatchObject({ promptTokens: 8, completionTokens: 42, totalTokens: 50, reasoningTokens: 40, cachedTokens: 4 });
  });

  it('reads a CRLF stream that has no [DONE] marker', async () => {
    const { calls } = stub(() => sse([
      { candidates: [{ content: { parts: [{ text: '1, 2' }] } }] },
      { candidates: [{ content: { parts: [{ text: ', 3' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 10 } },
    ], { named: false, crlf: true }));
    let text = '';
    let finish: string | null = null;
    for await (const c of await hub().gateway.chat({
      model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'count' }], provider: GEMINI, trace: false, stream: true,
    })) {
      text += c.delta.content ?? '';
      finish = c.finishReason ?? finish;
    }
    expect(calls[0].url).toMatch(/:streamGenerateContent\?alt=sse$/);
    expect([text, finish]).toEqual(['1, 2, 3', 'stop']);
  });

  it('merges extraBody into generationConfig and refuses a clash with a named option', async () => {
    const { calls } = stub(() => json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] }));
    const client = hub();
    const messages = [{ role: 'user' as const, content: 'q' }];
    await client.gateway.chat({
      model: 'g', messages, provider: GEMINI, trace: false, temperature: 0.2,
      extraBody: { generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } },
    });
    const err = await client.gateway.chat({
      model: 'g', messages, provider: GEMINI, trace: false, temperature: 0.2,
      extraBody: { generationConfig: { temperature: 1 } },
    }).catch((e: unknown) => e);
    expect(calls[0].body['generationConfig']).toEqual({ temperature: 0.2, thinkingConfig: { thinkingLevel: 'low' } });
    expect((err as acruxcoreError).code).toBe('VALIDATION_ERROR');
    expect(calls).toHaveLength(1);
  });
});

describe('BYO provider kind resolution', () => {
  it.each([
    ['https://api.anthropic.com/v1/', 'https://api.anthropic.com/v1/messages'],
    ['https://generativelanguage.googleapis.com/v1beta', 'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent'],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'],
    ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/chat/completions'],
  ])('the host %s picks the format when kind is left out', async (baseUrl, expected) => {
    const { calls } = stub(() => json({ error: 'stop here' }, 500));
    await hub().gateway.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }], provider: { baseUrl, apiKey: 'k' }, trace: false })
      .catch(() => undefined);
    expect(calls.map((c) => c.url)).toEqual([expected]);
  });

  it('still requires baseUrl for an openai_compatible kind', async () => {
    const err = await hub().gateway.chat({
      model: 'm', messages: [{ role: 'user', content: 'q' }], provider: { kind: 'openai_compatible', apiKey: 'k' }, trace: false,
    }).catch((e: unknown) => e);
    expect((err as acruxcoreError).code).toBe('MISSING_BASE_URL');
  });

  it('does not send reasoningEffort to a native provider, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { calls } = stub(() => json({ id: 'm', model: 'c', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: {} }));
    await hub().gateway.chat({ model: 'c', messages: [{ role: 'user', content: 'q' }], provider: ANTHROPIC, trace: false, reasoningEffort: 'high' });
    expect(calls[0].body['reasoning_effort']).toBeUndefined();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('reasoningEffort is not sent'))).toBe(true);
  });
});

describe('PR #827 review findings', () => {
  it('reads a Gemini stream whose CRLF is split across two network reads', async () => {
    const f1 = 'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\r\n\r\n';
    const f2 = 'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}]}\r\n\r\n';
    const raw = new TextEncoder().encode(f1 + f2);
    const cut = f1.length - 1; // the first read ends with "\r\n\r", the second starts with "\n"
    stub(() => new Response(new ReadableStream({
      start(c) { c.enqueue(raw.slice(0, cut)); c.enqueue(raw.slice(cut)); c.close(); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    let text = '';
    for await (const c of await hub().gateway.chat({
      model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'hi' }], provider: GEMINI, trace: false, stream: true,
    })) text += c.delta.content ?? '';
    expect(text).toBe('Hello');
  });

  const THINKING = { type: 'thinking', thinking: 'Need the weather.', signature: 'SIG-A' };
  const REDACTED = { type: 'redacted_thinking', data: 'ENC' };
  const thinkingOn = { thinking: { type: 'enabled', budget_tokens: 1024 } };

  it('sends Anthropic thinking blocks back before the tool_use on the next turn', async () => {
    const replies = [
      { id: 'm1', model: 'claude-x', stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 },
        content: [THINKING, REDACTED, { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } }] },
      { id: 'm2', model: 'claude-x', stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 2 },
        content: [{ type: 'text', text: 'Mild.' }] },
    ];
    const { calls } = stub((_u, _b, i) => json(replies[i]));
    const client = hub();
    const messages: Parameters<typeof client.gateway.chat>[0]['messages'] = [{ role: 'user', content: 'weather?' }];
    const r = await client.gateway.chat({ model: 'claude-x', messages, tools: WEATHER, provider: ANTHROPIC, trace: false, extraBody: thinkingOn });
    messages.push(r.message, { role: 'tool', tool_call_id: 'tu_1', content: '{"temp": 18}' });
    const r2 = await client.gateway.chat({ model: 'claude-x', messages, tools: WEATHER, provider: ANTHROPIC, trace: false, extraBody: thinkingOn });
    expect((calls[1].body['messages'] as Json[])[1]['content']).toEqual([
      THINKING, REDACTED, { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
    ]);
    expect(r2.content).toBe('Mild.');
  });

  it('puts streamed Anthropic thinking on the first tool call', async () => {
    stub(() => sse([
      { type: 'message_start', message: { id: 'm1', model: 'claude-x', usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need the ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weather.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-A' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: REDACTED },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city": "Paris"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ], { named: true }));
    const deltas: Json[] = [];
    for await (const c of await hub().gateway.chat({
      model: 'claude-x', messages: [{ role: 'user', content: 'weather?' }], tools: WEATHER, provider: ANTHROPIC,
      trace: false, stream: true, extraBody: thinkingOn,
    })) deltas.push(...((c.delta.tool_calls ?? []) as Json[]));
    expect(deltas[0]['id']).toBe('tu_1');
    expect(deltas[0]['extra_content']).toEqual({ anthropic: { thinking_blocks: [THINKING, REDACTED] } });
  });

  const TOOL_USE = { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } };

  it('sends extraBody on every runToolLoop round and thinking blocks back on round two (issue #829)', async () => {
    const replies = [
      { id: 'm1', model: 'claude-x', stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 },
        content: [THINKING, REDACTED, TOOL_USE] },
      { id: 'm2', model: 'claude-x', stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 2 },
        content: [{ type: 'text', text: 'Mild.' }] },
    ];
    const { calls } = stub((_u, _b, i) => json(replies[i]));
    const r = await hub().gateway.runToolLoop({
      model: 'claude-x', messages: [{ role: 'user', content: 'weather?' }], toolDefs: WEATHER,
      dispatch: () => ({ temp: 18 }), provider: ANTHROPIC, trace: false, maxTokens: 2048, extraBody: thinkingOn,
    });
    expect(r.content).toBe('Mild.');
    expect(calls.map((c) => c.body['thinking'])).toEqual([thinkingOn.thinking, thinkingOn.thinking]);
    expect((calls[1].body['messages'] as Json[])[1]).toEqual({ role: 'assistant', content: [THINKING, REDACTED, TOOL_USE] });
  });

  it('sends extraBody on every streamed runToolLoop round and streamed thinking back on round two', async () => {
    const rounds: Json[][] = [
      [
        { type: 'message_start', message: { id: 'm1', model: 'claude-x', usage: { input_tokens: 5 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need the weather.' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-A' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: REDACTED },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { ...TOOL_USE, input: {} } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city": "Paris"}' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
        { type: 'message_stop' },
      ],
      [
        { type: 'message_start', message: { id: 'm2', model: 'claude-x', usage: { input_tokens: 9 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Mild.' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ],
    ];
    const { calls } = stub((_u, _b, i) => sse(rounds[i], { named: true }));
    const events = [];
    for await (const ev of await hub().gateway.runToolLoop({
      model: 'claude-x', messages: [{ role: 'user', content: 'weather?' }], toolDefs: WEATHER,
      dispatch: () => ({ temp: 18 }), provider: ANTHROPIC, trace: false, maxTokens: 2048,
      extraBody: thinkingOn, stream: true,
    })) events.push(ev);
    const done = events[events.length - 1];
    expect(done.type === 'done' && done.result.content).toBe('Mild.');
    expect(calls.map((c) => c.body['thinking'])).toEqual([thinkingOn.thinking, thinkingOn.thinking]);
    expect((calls[1].body['messages'] as Json[])[1]).toEqual({ role: 'assistant', content: [THINKING, REDACTED, TOOL_USE] });
  });

  it('leaves thinking out of the Anthropic shaping round and keeps every other extraBody key', async () => {
    const replies = [
      { id: 'm1', model: 'claude-x', stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 },
        content: [THINKING, TOOL_USE] },
      { id: 'm2', model: 'claude-x', stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 2 },
        content: [{ type: 'text', text: 'Paris is 18.' }] },
      { id: 'm3', model: 'claude-x', stop_reason: 'tool_use', usage: { input_tokens: 9, output_tokens: 2 },
        content: [{ type: 'tool_use', id: 'tu_f', name: 'report', input: { paris: 18 } }] },
    ];
    const { calls } = stub((_u, _b, i) => json(replies[i]));
    const r = await hub().gateway.runToolLoop({
      model: 'claude-x', messages: [{ role: 'user', content: 'weather?' }], toolDefs: WEATHER,
      dispatch: () => ({ temp: 18 }), provider: ANTHROPIC, trace: false, maxTokens: 2048,
      extraBody: { ...thinkingOn, metadata: { user_id: 'u1' } },
      responseFormat: { type: 'json_schema', json_schema: { name: 'report', schema: {
        type: 'object', properties: { paris: { type: 'number' } }, required: ['paris'] } } },
    });
    expect(JSON.parse(r.content ?? '')).toEqual({ paris: 18 });
    expect(calls.map((c) => c.body['thinking'])).toEqual([thinkingOn.thinking, thinkingOn.thinking, undefined]);
    expect(calls.map((c) => c.body['metadata'])).toEqual(Array(3).fill({ user_id: 'u1' }));
    expect(calls[2].body['tool_choice']).toEqual({ type: 'tool', name: 'report' });
  });

  const REPORT_RF = { type: 'json_schema' as const, json_schema: { name: 'report', schema: {
    type: 'object', properties: { paris: { type: 'number' } }, required: ['paris'] } } };
  const REPORT_REPLY = { id: 'm3', model: 'claude-x', stop_reason: 'tool_use', usage: { input_tokens: 9, output_tokens: 2 },
    content: [{ type: 'tool_use', id: 'tu_f', name: 'report', input: { paris: 18 } }] };

  it('leaves thinking out wherever responseFormat goes to Anthropic: chat() and a loop with no tools', async () => {
    const { calls } = stub(() => json(REPORT_REPLY));
    const extraBody = { ...thinkingOn, metadata: { user_id: 'u1' } };
    const messages = [{ role: 'user' as const, content: 'weather?' }];
    const client = hub();
    await client.gateway.chat({
      model: 'claude-x', messages, provider: ANTHROPIC, trace: false, maxTokens: 2048, responseFormat: REPORT_RF, extraBody,
    });
    const r = await client.gateway.runToolLoop({
      model: 'claude-x', messages, provider: ANTHROPIC, trace: false, maxTokens: 2048, responseFormat: REPORT_RF, extraBody,
    });
    expect(JSON.parse(r.content ?? '')).toEqual({ paris: 18 });
    expect(calls.map((c) => c.body['thinking'])).toEqual([undefined, undefined]);
    expect(calls.map((c) => c.body['metadata'])).toEqual([{ user_id: 'u1' }, { user_id: 'u1' }]);
    expect(calls.map((c) => c.body['tool_choice'])).toEqual(Array(2).fill({ type: 'tool', name: 'report' }));
  });

  it('leaves thinking out of the streamed shaping round when the provider comes from the client', async () => {
    const rounds: Json[][] = [
      [
        { type: 'message_start', message: { id: 'm1', model: 'claude-x', usage: { input_tokens: 5 } } },
        { type: 'content_block_start', index: 0, content_block: { ...TOOL_USE, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city": "Paris"}' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
        { type: 'message_stop' },
      ],
      [
        { type: 'message_start', message: { id: 'm2', model: 'claude-x', usage: { input_tokens: 9 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Paris is 18.' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ],
      [
        { type: 'message_start', message: { id: 'm3', model: 'claude-x', usage: { input_tokens: 9 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_f', name: 'report', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"paris": 18}' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ],
    ];
    const { calls } = stub((_u, _b, i) => sse(rounds[i], { named: true }));
    const client = new acruxcore({ apiKey: 'acx', baseUrl: 'http://localhost:3000/api/v1', maxRetries: 0, provider: ANTHROPIC });
    const events = [];
    for await (const ev of await client.gateway.runToolLoop({
      model: 'claude-x', messages: [{ role: 'user', content: 'weather?' }], toolDefs: WEATHER,
      dispatch: () => ({ temp: 18 }), trace: false, maxTokens: 2048, extraBody: thinkingOn,
      responseFormat: REPORT_RF, stream: true,
    })) events.push(ev);
    const done = events[events.length - 1];
    expect(done.type === 'done' && JSON.parse(done.result.content ?? '')).toEqual({ paris: 18 });
    expect(calls.map((c) => c.body['thinking'])).toEqual([thinkingOn.thinking, thinkingOn.thinking, undefined]);
    expect(calls[2].body['tool_choice']).toEqual({ type: 'tool', name: 'report' });
  });

  it('reports stoppedAtLimit from the tool rounds when a responseFormat loop is cut off', async () => {
    const { calls } = stub((_u, _b, i) => json(i < 2
      ? { id: `m${i}`, model: 'claude-x', stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 },
          content: [{ ...TOOL_USE, id: `tu_${i}` }] }
      : REPORT_REPLY));
    const r = await hub().gateway.runToolLoop({
      model: 'claude-x', messages: [{ role: 'user', content: 'weather?' }], toolDefs: WEATHER,
      dispatch: () => ({ temp: 18 }), provider: ANTHROPIC, trace: false, maxIterations: 2, responseFormat: REPORT_RF,
    });
    expect(calls).toHaveLength(3);
    expect(JSON.parse(r.content ?? '')).toEqual({ paris: 18 });
    expect(r.stoppedAtLimit).toBe(true);
  });

  it('refuses an extraBody key runToolLoop already sets, before anything is sent', async () => {
    const { calls } = stub(() => json({}, 500));
    const client = hub();
    await expect(client.gateway.runToolLoop({
      model: 'claude-x', messages: [{ role: 'user', content: 'hi' }], provider: ANTHROPIC, trace: false,
      temperature: 0, extraBody: { temperature: 1 },
    })).rejects.toThrow(/extraBody may not set temperature/);
    await expect((async () => {
      for await (const _ of await client.gateway.runToolLoop({
        model: 'claude-x', messages: [{ role: 'user', content: 'hi' }], provider: ANTHROPIC, trace: false,
        stream: true, extraBody: { stream_options: {} },
      })) { /* drain */ }
    })()).rejects.toThrow(/extraBody may not set stream_options/);
    expect(calls).toHaveLength(0);
  });

  it('leaves an SDK-made Gemini call id off the functionResponse too', async () => {
    const replies = [
      { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [
        { functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] } }] },
      { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Mild.' }] } }] },
    ];
    const { calls } = stub((_u, _b, i) => json(replies[i]));
    await hub().gateway.runToolLoop({
      model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'weather?' }], toolDefs: WEATHER,
      dispatch: () => ({ temp: 18 }), provider: GEMINI, trace: false,
    });
    const contents = calls[1].body['contents'] as { parts: Json[] }[];
    expect(contents[1].parts[0]['functionCall']).toEqual({ name: 'get_weather', args: { city: 'Paris' } });
    expect(contents[2].parts[0]['functionResponse']).toEqual({ name: 'get_weather', response: { temp: 18 } });
  });

  it('sends max_completion_tokens as the native output limit', async () => {
    const { calls } = stub((url) => url.includes('anthropic')
      ? json({ id: 'm', model: 'c', stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'ok' }] })
      : json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] }));
    const messages = [{ role: 'user' as const, content: 'q' }];
    await hub().gateway.chat({ model: 'claude-x', messages, provider: ANTHROPIC, trace: false, extraBody: { max_completion_tokens: 4000 } });
    await hub().gateway.chat({ model: 'gemini-3.5-flash', messages, provider: GEMINI, trace: false, extraBody: { max_completion_tokens: 4000 } });
    expect(calls[0].body['max_tokens']).toBe(4000);
    expect((calls[1].body['generationConfig'] as Json)['maxOutputTokens']).toBe(4000);
  });
});
