import { describe, expect, it } from 'vitest';
import { formatHeaderLines, parseHeaderLines } from './connection-headers';

describe('parseHeaderLines', () => {
  it('reads one Name: value per line, skipping blank lines, and keeps colons in the value', () => {
    expect(parseHeaderLines('x-opencode-session: acx\n\n  X-Title : Docs: bot  \n')).toEqual({
      ok: true,
      headers: { 'x-opencode-session': 'acx', 'X-Title': 'Docs: bot' },
    });
  });

  it('gives an empty object for a blank field', () => {
    expect(parseHeaderLines('  \n')).toEqual({ ok: true, headers: {} });
  });

  it('names the line of a missing colon or a bad header name', () => {
    expect(parseHeaderLines('x-ok: 1\njust-text')).toEqual({ ok: false, error: 'Line 2: write it as Name: value.' });
    expect(parseHeaderLines('bad name: 1')).toMatchObject({ ok: false, error: expect.stringContaining('Line 1') });
  });
});

describe('parseHeaderLines: repeated names', () => {
  it('refuses a name repeated in another case, which HTTP treats as the same header', () => {
    expect(parseHeaderLines('X-Session: a\nx-session: b')).toEqual({
      ok: false,
      error: 'Line 2: x-session is already set on an earlier line. Header names ignore case.',
    });
  });
});

describe('formatHeaderLines', () => {
  it('round-trips through parseHeaderLines', () => {
    const headers = { 'x-a': '1', 'x-b': 'two words' };
    expect(parseHeaderLines(formatHeaderLines(headers))).toEqual({ ok: true, headers });
  });

  it('gives an empty field for no headers or a malformed value', () => {
    expect(formatHeaderLines(undefined)).toBe('');
    expect(formatHeaderLines(['x'])).toBe('');
  });
});
