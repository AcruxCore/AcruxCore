import { redactPayloadValue } from './redact';

describe('redactPayloadValue', () => {
  it('scrubs an OpenAI-style secret key embedded in a string', () => {
    const input = 'Use key sk-abcdEFGH12345678ijklMNOP for this call.';
    expect(redactPayloadValue(input)).toBe('Use key [REDACTED] for this call.');
  });

  it("scrubs this project's own acx_sk_ API key format", () => {
    const input = 'export API_KEY=acx_sk_9f8e7d6c5b4a3928170695847362514a';
    expect(redactPayloadValue(input)).toBe('export API_KEY=[REDACTED]');
  });

  it('scrubs a Bearer authorization token', () => {
    const input = 'Authorization: Bearer abc123.def456-ghi789_jkl';
    expect(redactPayloadValue(input)).toBe('Authorization: [REDACTED]');
  });

  it('scrubs an email address', () => {
    const input = 'Contact me at talha@livetheworld.com for access.';
    expect(redactPayloadValue(input)).toBe('Contact me at [REDACTED] for access.');
  });

  it('leaves ordinary text with no secret-shaped substrings untouched', () => {
    const input = 'The weather in Paris is sunny today.';
    expect(redactPayloadValue(input)).toBe(input);
  });

  it('recurses into nested objects and arrays', () => {
    const input = {
      messages: [
        { role: 'user', content: 'my key is sk-abcdEFGH12345678ijklMNOP' },
        { role: 'assistant', content: 'got it' },
      ],
      metadata: { userEmail: 'talha@livetheworld.com' },
    };
    const result = redactPayloadValue(input) as typeof input;
    expect(result.messages[0].content).toBe('my key is [REDACTED]');
    expect(result.messages[1].content).toBe('got it');
    expect(result.metadata.userEmail).toBe('[REDACTED]');
  });

  it('passes through non-string primitives and null unchanged', () => {
    const input = { count: 42, active: true, note: null };
    expect(redactPayloadValue(input)).toEqual({ count: 42, active: true, note: null });
  });

  it('does not mutate the original input', () => {
    const input = { content: 'my key is sk-abcdEFGH12345678ijklMNOP' };
    const original = JSON.parse(JSON.stringify(input));
    redactPayloadValue(input);
    expect(input).toEqual(original);
  });
});
