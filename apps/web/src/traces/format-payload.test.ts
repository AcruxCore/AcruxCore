import { describe, expect, it } from 'vitest';
import { formatPayload } from './format';

describe('formatPayload', () => {
  it('returns plain prose unquoted and unescaped', () => {
    expect(formatPayload('I want to visit London')).toBe('I want to visit London');
    expect(formatPayload('line one\nline two')).toBe('line one\nline two');
  });

  it('pretty-prints a value that is JSON hiding inside a string', () => {
    // The reported case: the stored payload is a JSON *string* whose content is
    // JSON, so JSON.stringify produced one long escaped line with no height to
    // expand.
    const stored = JSON.stringify({ role: 'system', content: 'You are a research assistant.' });
    expect(formatPayload(stored)).toBe(
      '{\n  "role": "system",\n  "content": "You are a research assistant."\n}',
    );
  });

  it('decodes JSON strings nested inside an object', () => {
    const value = { messages: JSON.stringify([{ role: 'user', content: 'hi' }]) };
    expect(formatPayload(value)).toBe(
      '{\n  "messages": [\n    {\n      "role": "user",\n      "content": "hi"\n    }\n  ]\n}',
    );
  });

  it('leaves a string that merely looks numeric alone', () => {
    // "12" parses as JSON, but it is text the caller sent; rendering it as a
    // number would misreport the payload.
    expect(formatPayload({ count: '12' })).toBe('{\n  "count": "12"\n}');
  });

  it('leaves a malformed JSON-ish string as written', () => {
    expect(formatPayload('{not really json}')).toBe('{not really json}');
  });

  it('renders an ordinary object as indented JSON', () => {
    expect(formatPayload({ name: 'Al' })).toBe('{\n  "name": "Al"\n}');
  });

  it('renders an absent payload as empty rather than "undefined"', () => {
    expect(formatPayload(undefined)).toBe('');
  });
});
