import { describe, expect, it } from 'vitest';
import { summarizeJson } from './json-summary';

describe('summarizeJson', () => {
  it('lists an object’s scalar fields inline', () => {
    expect(summarizeJson({ price: 120, currency: 'USD' })).toBe('{price: 120, currency: "USD"}');
  });
  it('counts nested lists and objects instead of printing them', () => {
    expect(summarizeJson({ available: true, rooms: [{}, {}, {}] })).toBe('{available: true, rooms: 3 items}');
    expect(summarizeJson({ meta: { a: 1 } })).toBe('{meta: {1 field}}');
  });
  it('counts a top-level list', () => {
    expect(summarizeJson([1, 2, 3, 4, 5])).toBe('5 items');
    expect(summarizeJson([{}])).toBe('1 item');
  });
  it('decodes an object stored as a JSON string', () => {
    expect(summarizeJson('{"price":49}')).toBe('{price: 49}');
  });
  it('cuts a long summary at 80 characters', () => {
    const s = summarizeJson({ a: 'x'.repeat(200) });
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s.endsWith('…')).toBe(true);
  });
  it('returns plain text as is, cut to one line', () => {
    expect(summarizeJson('Shipped on 2026-11-18.\nThanks')).toBe('Shipped on 2026-11-18. Thanks');
  });
});
