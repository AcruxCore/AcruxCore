import { canonicalJson } from './canonical-json';

describe('canonicalJson', () => {
  it('produces the same string regardless of key order', () => {
    const a = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
    const b = { required: ['city'], properties: { city: { type: 'string' } }, type: 'object' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('sorts keys at every depth, not only the top level', () => {
    const a = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const b = { outer: { a: { b: 3, y: 2 }, z: 1 } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('preserves array order — a reordered `required` IS a different schema', () => {
    expect(canonicalJson({ required: ['a', 'b'] })).not.toBe(canonicalJson({ required: ['b', 'a'] }));
  });

  it('distinguishes a missing key from an explicit null', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 1, b: null }));
  });

  it('treats an absent value and an explicit undefined as equal', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('handles primitives and null at the top level', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(3)).toBe('3');
    expect(canonicalJson('x')).toBe('"x"');
  });

  it('sorts keys inside objects nested in arrays', () => {
    const a = { items: [{ b: 1, a: 2 }] };
    const b = { items: [{ a: 2, b: 1 }] };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});
