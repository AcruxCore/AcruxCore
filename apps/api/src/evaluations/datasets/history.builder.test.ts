import {
  buildTraceExchange,
  capHistoryBytes,
  sanitizeForReplay,
  type LlmSpanForHistory,
} from './history.builder';
import type { ChatMessage } from '../../gateway/providers/types';

/** Wraps a bare assistant message as a captured gateway response body. */
function response(message: { role: 'assistant'; content: string | null; tool_calls?: unknown[] }): LlmSpanForHistory['output'] {
  return { choices: [{ message }] };
}

describe('buildTraceExchange', () => {
  it('returns [lastUserMessage, output message] for a trace with one llm span', () => {
    const spans: LlmSpanForHistory[] = [
      {
        input: [
          { role: 'system', content: 'You are a support agent.' },
          { role: 'user', content: 'My order is late' },
        ],
        output: response({ role: 'assistant', content: 'Sorry to hear that — what is your order number?' }),
      },
    ];
    expect(buildTraceExchange(spans)).toEqual([
      { role: 'user', content: 'My order is late' },
      { role: 'assistant', content: 'Sorry to hear that — what is your order number?' },
    ]);
  });

  it('drops earlier resent history from the first span input, keeping only the newest user message', () => {
    const spans: LlmSpanForHistory[] = [
      {
        input: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'turn 1' },
          { role: 'assistant', content: 'reply 1' },
          { role: 'user', content: 'turn 2 — the new ask' },
        ],
        output: response({ role: 'assistant', content: 'reply 2' }),
      },
    ];
    expect(buildTraceExchange(spans)).toEqual([
      { role: 'user', content: 'turn 2 — the new ask' },
      { role: 'assistant', content: 'reply 2' },
    ]);
  });

  it('includes an intra-trace tool round trip by diffing the second span against the first', () => {
    const spans: LlmSpanForHistory[] = [
      {
        input: [{ role: 'user', content: 'what is the weather in Cebu?' }],
        output: response({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Cebu"}' } }],
        }),
      },
      {
        input: [
          { role: 'user', content: 'what is the weather in Cebu?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Cebu"}' } }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '{"tempC":30}' },
        ],
        output: response({ role: 'assistant', content: 'It is 30°C in Cebu.' }),
      },
    ];
    expect(buildTraceExchange(spans)).toEqual([
      { role: 'user', content: 'what is the weather in Cebu?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Cebu"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"tempC":30}' },
      { role: 'assistant', content: 'It is 30°C in Cebu.' },
    ]);
  });

  it('degrades to appending outputs when a later span does not extend the prior one (non-append-only integration)', () => {
    const spans: LlmSpanForHistory[] = [
      {
        input: [{ role: 'user', content: 'first' }],
        output: response({ role: 'assistant', content: 'a1', tool_calls: [{ id: 'x', type: 'function', function: { name: 'f', arguments: '{}' } }] }),
      },
      { input: [{ role: 'user', content: 'a completely different array' }], output: response({ role: 'assistant', content: 'a2' }) },
    ];
    expect(buildTraceExchange(spans)).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a1', tool_calls: [{ id: 'x', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'assistant', content: 'a2' },
    ]);
  });

  it('returns [] for a trace with no llm span', () => {
    expect(buildTraceExchange([])).toEqual([]);
  });

  // Both published SDKs report an `llm` span as `input: { messages }` +
  // `output: <bare assistant message>` (packages/sdk/src/client.ts,
  // packages/sdk-python/src/acruxcore/client.py), NOT the gateway hook's
  // `input: ChatMessage[]` + `output: { choices: [...] }`. Reading only the
  // gateway shape threw and 500'd the whole dataset build.
  it('accepts the SDK payload shape: input {messages}, output a bare message', () => {
    const spans: LlmSpanForHistory[] = [
      {
        input: { messages: [{ role: 'user', content: 'My order is late' }] },
        output: { role: 'assistant', content: 'What is your order number?' },
      },
    ];
    expect(buildTraceExchange(spans)).toEqual([
      { role: 'user', content: 'My order is late' },
      { role: 'assistant', content: 'What is your order number?' },
    ]);
  });

  it('skips a span whose captured payload is neither shape instead of throwing', () => {
    const spans: LlmSpanForHistory[] = [
      { input: 'a bare string', output: 42 },
      {
        input: [{ role: 'user', content: 'still readable' }],
        output: response({ role: 'assistant', content: 'ok' }),
      },
    ];
    expect(buildTraceExchange(spans)).toEqual([
      { role: 'user', content: 'still readable' },
      { role: 'assistant', content: 'ok' },
    ]);
  });

  it('returns [] when no span in the trace has a readable payload', () => {
    expect(buildTraceExchange([{ input: null, output: null }, { input: 7, output: 'x' }])).toEqual([]);
  });

  // A gateway-path `chat({ trace: { sessionId } })` call has the gateway write
  // its own llm span AND the SDK self-report one for the same turn, so the
  // trace holds two spans describing one exchange.
  it('drops a duplicate span that repeats the previous turn (gateway span + SDK self-report)', () => {
    const messages = [{ role: 'user' as const, content: 'My order is late' }];
    const reply = { role: 'assistant' as const, content: 'What is your order number?' };
    const spans: LlmSpanForHistory[] = [
      { input: messages, output: response(reply) },
      { input: { messages }, output: reply },
    ];
    expect(buildTraceExchange(spans)).toEqual([messages[0], reply]);
  });
});

describe('sanitizeForReplay', () => {
  // Trimming back to the next `user` message, rather than just dropping the
  // orphan, keeps the array valid for Anthropic too — its adapter requires the
  // first non-system message to be `user` (anthropic.adapter.ts).
  it('drops a leading orphan tool result, back to the next user turn', () => {
    const messages = [
      { role: 'tool', tool_call_id: 'c1', content: '{"r":1}' },
      { role: 'assistant', content: 'final' },
      { role: 'user', content: 'next ask' },
      { role: 'assistant', content: 'next answer' },
    ] as unknown as ChatMessage[];
    expect(sanitizeForReplay(messages)).toEqual([
      { role: 'user', content: 'next ask' },
      { role: 'assistant', content: 'next answer' },
    ]);
  });

  it('returns [] when a fragment has no user turn left to start from', () => {
    const messages = [
      { role: 'tool', tool_call_id: 'c1', content: '{"r":1}' },
      { role: 'assistant', content: 'final' },
    ] as unknown as ChatMessage[];
    expect(sanitizeForReplay(messages)).toEqual([]);
  });

  it('drops a leading assistant tool_calls whose results were trimmed away', () => {
    const messages = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'user', content: 'next ask' },
      { role: 'assistant', content: 'answer' },
    ] as unknown as ChatMessage[];
    expect(sanitizeForReplay(messages)).toEqual([
      { role: 'user', content: 'next ask' },
      { role: 'assistant', content: 'answer' },
    ]);
  });

  it('drops a trailing unanswered assistant tool_calls (a trace that ended mid-loop)', () => {
    const messages = [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    ] as unknown as ChatMessage[];
    expect(sanitizeForReplay(messages)).toEqual([{ role: 'user', content: 'weather?' }]);
  });

  it('leaves a well-formed tool round trip untouched', () => {
    const messages = [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"tempC":30}' },
      { role: 'assistant', content: 'It is 30°C.' },
    ] as unknown as ChatMessage[];
    expect(sanitizeForReplay(messages)).toEqual(messages);
  });

  it('returns [] when nothing replayable is left', () => {
    const messages = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    ] as unknown as ChatMessage[];
    expect(sanitizeForReplay(messages)).toEqual([]);
  });
});

describe('capHistoryBytes', () => {
  it('returns the input unchanged when already within budget', () => {
    const messages = [{ role: 'user' as const, content: 'hi' }];
    expect(capHistoryBytes(messages, 1000)).toEqual(messages);
  });

  it('drops the oldest turns first until the serialized size fits', () => {
    const big = 'x'.repeat(50);
    const messages = [
      { role: 'user' as const, content: `oldest-${big}` },
      { role: 'assistant' as const, content: `middle-${big}` },
      { role: 'user' as const, content: `newest-${big}` },
    ];
    const capped = capHistoryBytes(messages, 100);
    expect(capped[capped.length - 1]).toEqual(messages[2]);
    expect(capped.some((m) => m.content?.startsWith('oldest'))).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(capped), 'utf8')).toBeLessThanOrEqual(100);
  });

  it('never leaves a leading orphan tool result when the cut lands mid tool round trip', () => {
    const big = 'y'.repeat(300);
    const messages = [
      { role: 'user', content: `q ${big}` },
      { role: 'assistant', content: big, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"r":1}' },
      { role: 'assistant', content: 'weather answer' },
      { role: 'user', content: 'and tomorrow?' },
      { role: 'assistant', content: 'sunny' },
    ] as unknown as ChatMessage[];

    // A budget that cuts inside the tool round trip: the raw byte trim would
    // leave [tool, assistant, user, assistant], which no provider accepts.
    const capped = capHistoryBytes(messages, 130);
    expect(capped).toEqual([
      { role: 'user', content: 'and tomorrow?' },
      { role: 'assistant', content: 'sunny' },
    ]);
  });

  it('returns [] rather than an unreplayable fragment when the budget fits no whole turn', () => {
    const messages = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"r":1}' },
      { role: 'assistant', content: 'final' },
    ] as unknown as ChatMessage[];
    expect(capHistoryBytes(messages, 40)).toEqual([]);
  });
});
