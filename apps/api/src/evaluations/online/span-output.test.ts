import { judgeableOutput } from './span-output';

describe('judgeableOutput (issue #505)', () => {
  it("returns the assistant's text from a chat-completion envelope", () => {
    expect(
      judgeableOutput({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1751536800,
        model: 'gpt-4o-mini',
        usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' }],
      }),
    ).toBe('Hi!');
  });

  it('returns the assistant message when the turn is tool calls with no text', () => {
    const message = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
    };
    expect(judgeableOutput({ object: 'chat.completion', choices: [{ message }] })).toEqual(message);
  });

  it('returns the text from a span reported by either published SDK', () => {
    // Both SDKs write `output: result.message` — the bare assistant message, with no
    // `choices` around it. Reading `choices` alone left the documented SDK path handing
    // the judge a JSON object, which is the #505 failure this function exists to fix.
    expect(judgeableOutput({ role: 'assistant', content: 'Paris is the capital of France.' })).toBe(
      'Paris is the capital of France.',
    );
  });

  it('returns the tool calls when a provider writes an empty string instead of null', () => {
    // Anthropic and Gemini build a pure tool-calling turn as `content: ''` (their
    // adapters join the text parts of a response that has none), and the streaming path
    // accumulates from an `''` seed. Testing `content` before `tool_calls` narrowed all
    // of those to "" — so a rule about tool use graded an empty string.
    const message = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
    };
    expect(judgeableOutput({ choices: [{ message }] })).toEqual(message);
    expect(judgeableOutput(message)).toEqual(message);
  });

  it('keeps the tool calls when the turn also carried a text preamble', () => {
    // "Let me look that up." plus the calls. Returning only the preamble told a rule
    // like "must call get_weather before answering" that no tool was ever called.
    const message = {
      role: 'assistant',
      content: 'Let me look that up.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
    };
    expect(judgeableOutput({ choices: [{ message }] })).toEqual(message);
  });

  it('joins the text parts of a multi-part content array', () => {
    expect(
      judgeableOutput({
        choices: [{ message: { role: 'assistant', content: [{ type: 'text', text: 'Paris.' }] } }],
      }),
    ).toBe('Paris.');
  });

  it('returns an empty string for a genuinely empty answer, not the envelope', () => {
    // No tool calls and no text: the model really did say nothing, and the judge should
    // grade that rather than the bookkeeping around it.
    expect(judgeableOutput({ choices: [{ message: { role: 'assistant', content: '' } }] })).toBe('');
  });

  it('passes a plain string through — an SDK-ingested span may already store one', () => {
    expect(judgeableOutput('already the answer')).toBe('already the answer');
  });

  it('passes an unrecognised shape through unchanged rather than guessing', () => {
    const custom = { result: { rows: [1, 2, 3] } };
    expect(judgeableOutput(custom)).toBe(custom);
  });

  it('passes null and an empty choices array through unchanged', () => {
    expect(judgeableOutput(null)).toBeNull();
    const empty = { object: 'chat.completion', choices: [] };
    expect(judgeableOutput(empty)).toBe(empty);
  });
});
