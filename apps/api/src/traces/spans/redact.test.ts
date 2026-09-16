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

describe('redactPayloadValue — real key formats (issue #481)', () => {
  // The generator is `randomBytes(30).toString('base64url')`, so a real key
  // contains '-' and '_'. A `[A-Za-z0-9]` class stopped at the first of those and
  // left most of the key readable; `agh_sk_` had no pattern at all.
  const acxWithSeparators = 'acx_sk_UaTTBXi6SSfmO1c2UYfOsXng769DeDlZSCofh_dM';
  const aghWithSeparators = 'agh_sk_Tg-MKqVtZsNJRCq5hmU_zXH7Yo99VoPw3f56ayc';

  it('scrubs a platform key containing - and _', () => {
    expect(redactPayloadValue(`key=${acxWithSeparators}`)).toBe('key=[REDACTED]');
  });

  it('scrubs a gateway virtual key', () => {
    expect(redactPayloadValue(`key=${aghWithSeparators}`)).toBe('key=[REDACTED]');
  });

  it('scrubs both when they appear in one payload', () => {
    const out = redactPayloadValue({
      messages: [{ role: 'user', content: `platform ${acxWithSeparators} gateway ${aghWithSeparators}` }],
    }) as { messages: { content: string }[] };
    expect(out.messages[0].content).not.toContain(acxWithSeparators);
    expect(out.messages[0].content).not.toContain(aghWithSeparators);
    expect(out.messages[0].content).toBe('platform [REDACTED] gateway [REDACTED]');
  });

  it('leaves no readable tail when the key ends in a separator character', () => {
    const trailing = 'acx_sk_abcdEFGH12345678ijklMNOPqrst_';
    expect(redactPayloadValue(trailing)).toBe('[REDACTED]');
  });

  // The mirror image of the case above, and the one a real payload hits most often:
  // `\b` does not match *before* the key either when the preceding character is a word
  // character, so every one of these shapes was stored completely in clear text.
  it.each([
    ['an env-var assignment', `ACRUXCORE_API_KEY_${acxWithSeparators}`],
    ['a shell export line', `export MY_KEY_${acxWithSeparators}`],
    ['an f-string concatenation', `token${acxWithSeparators}`],
    ['a virtual key after an underscore', `VKEY_${aghWithSeparators}`],
  ])('scrubs a key preceded by a word character — %s', (_label, payload) => {
    const out = redactPayloadValue(payload) as string;
    expect(out).not.toContain('acx_sk_');
    expect(out).not.toContain('agh_sk_');
    expect(out).toContain('[REDACTED]');
  });

  it('keeps Bearer and its token as one replacement', () => {
    // Documented invariant: the placeholder must read `Authorization: [REDACTED]`, not
    // `Authorization: Bearer [REDACTED]`. A key pattern ordered ahead of Bearer wins the
    // token substring and leaves the scheme behind.
    expect(redactPayloadValue(`Authorization: Bearer ${acxWithSeparators}`)).toBe(
      'Authorization: [REDACTED]',
    );
  });

  it('does not redact ordinary prose that merely contains sk-', () => {
    // Why `sk-` keeps a leading anchor while acx_sk_/agh_sk_ drop theirs: unanchored,
    // `sk-` plus 16 word characters matches inside real words, and a span payload is
    // the user's own prompt text.
    const prose = 'We took a multitask-oriented-approach to the rollout.';
    expect(redactPayloadValue(prose)).toBe(prose);
  });

  it('does not leave the domain behind when a key is used as an email local part', () => {
    expect(redactPayloadValue(`${acxWithSeparators}@example.com`)).toBe('[REDACTED]');
  });
});
