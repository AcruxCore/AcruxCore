import { describe, expect, it } from 'vitest';
import { DEFAULT_NEXT, safeNext } from './next-param';

describe('safeNext', () => {
  it('returns a same-origin path unchanged', () => {
    expect(safeNext('/invite/abc123')).toBe('/invite/abc123');
    expect(safeNext('/team?tab=members')).toBe('/team?tab=members');
  });

  it('falls back when there is no value', () => {
    expect(safeNext(null)).toBe(DEFAULT_NEXT);
    expect(safeNext(undefined)).toBe(DEFAULT_NEXT);
    expect(safeNext('')).toBe(DEFAULT_NEXT);
  });

  it('rejects an absolute URL', () => {
    expect(safeNext('https://evil.example/x')).toBe(DEFAULT_NEXT);
    expect(safeNext('javascript:alert(1)')).toBe(DEFAULT_NEXT);
  });

  it('rejects a protocol-relative host', () => {
    expect(safeNext('//evil.example')).toBe(DEFAULT_NEXT);
  });

  it('rejects the backslash variant browsers normalise to //', () => {
    expect(safeNext('/\\evil.example')).toBe(DEFAULT_NEXT);
  });

  it('rejects a path with no leading slash', () => {
    expect(safeNext('prompts')).toBe(DEFAULT_NEXT);
  });

  it('rejects control characters that the URL parser would strip into //', () => {
    // The WHATWG URL parser drops ASCII tab/LF/CR before parsing, so each of
    // these becomes a protocol-relative `//evil.example` by the time a
    // browser navigates to it — even though the raw string starts with a
    // single `/` and is not literally `//` or `/\`.
    expect(safeNext('/\t/evil.example')).toBe(DEFAULT_NEXT);
    expect(safeNext('/\n/evil.example')).toBe(DEFAULT_NEXT);
    expect(safeNext('/\r/evil.example')).toBe(DEFAULT_NEXT);
    expect(safeNext('/\t\t//evil.example')).toBe(DEFAULT_NEXT);
  });

  it('leaves a legitimate path with no control characters unchanged', () => {
    expect(safeNext('/invite/abc123')).toBe('/invite/abc123');
  });
});
