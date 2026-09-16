import { validateAgainstSchema } from './result-schema';

describe('validateAgainstSchema', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      q: { type: 'string', maxLength: 5 },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
      sort: { type: 'string', enum: ['asc', 'desc'] },
    },
    required: ['q'],
  };

  it('accepts a value that satisfies every declared keyword', () => {
    expect(validateAgainstSchema({ q: 'ok', limit: 3, sort: 'asc' }, schema, 'arguments', { bounds: true })).toBeNull();
  });

  it('reports a missing required property regardless of strictness', () => {
    expect(validateAgainstSchema({}, schema)).toBe("result is missing required property 'q'");
  });

  it('reports a wrong type regardless of strictness', () => {
    expect(validateAgainstSchema({ q: 'ok', limit: 'lots' }, schema)).toBe('result.limit should be integer, got string');
  });

  it('ignores numeric and string bounds by default — the result-checking contract (issue #506)', () => {
    // A result-schema warning that cried wolf would get switched off, so the
    // lenient default stays exactly as it was.
    expect(validateAgainstSchema({ q: 'far too long', limit: 100000 }, schema)).toBeNull();
  });

  it('enforces numeric bounds when the caller opts in', () => {
    expect(validateAgainstSchema({ q: 'ok', limit: 100000 }, schema, 'arguments', { bounds: true })).toBe(
      'arguments.limit should be <= 10, got 100000',
    );
    expect(validateAgainstSchema({ q: 'ok', limit: 0 }, schema, 'arguments', { bounds: true })).toBe(
      'arguments.limit should be >= 1, got 0',
    );
  });

  it('enforces string length when the caller opts in', () => {
    expect(validateAgainstSchema({ q: 'far too long' }, schema, 'arguments', { bounds: true })).toBe(
      'arguments.q should be at most 5 characters, got 12',
    );
  });

  it('enforces additionalProperties: false only when the caller opts in', () => {
    expect(validateAgainstSchema({ q: 'ok', extra: 1 }, schema)).toBeNull();
    expect(validateAgainstSchema({ q: 'ok', extra: 1 }, schema, 'arguments', { bounds: true })).toBe(
      "arguments does not allow the property 'extra'",
    );
  });

  it('closes a schema that declares no properties at all', () => {
    // `{additionalProperties:false}` with no `properties` key is the STRICTEST spelling
    // there is: it declares nothing, so it allows nothing. Requiring the key made the
    // strict form the one that accepted anything, while the same intent written as
    // `properties:{}` was enforced — identical schemas, opposite answers.
    const closed = { type: 'object', additionalProperties: false };
    expect(validateAgainstSchema({ evil: 'x' }, closed, 'arguments', { bounds: true })).toBe(
      "arguments does not allow the property 'evil'",
    );
    const closedEmpty = { type: 'object', additionalProperties: false, properties: {} };
    expect(validateAgainstSchema({ evil: 'x' }, closedEmpty, 'arguments', { bounds: true })).toBe(
      "arguments does not allow the property 'evil'",
    );
    expect(validateAgainstSchema({}, closed, 'arguments', { bounds: true })).toBeNull();
  });

  it('counts a string bound in characters, not UTF-16 code units', () => {
    // `String.prototype.length` counts code units, so every emoji and every other astral
    // character counted double and a three-character argument was refused as six — in a
    // message that said "characters". A false rejection ends the whole tool call.
    const short = { type: 'object', properties: { q: { type: 'string', maxLength: 3 } } };
    expect(validateAgainstSchema({ q: '\u{1F44D}\u{1F44D}\u{1F44D}' }, short, 'arguments', { bounds: true })).toBeNull();
    expect(validateAgainstSchema({ q: '\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}' }, short, 'arguments', { bounds: true })).toBe(
      'arguments.q should be at most 3 characters, got 4',
    );
    const long = { type: 'object', properties: { q: { type: 'string', minLength: 3 } } };
    expect(validateAgainstSchema({ q: '\u{1F44D}\u{1F44D}\u{1F44D}' }, long, 'arguments', { bounds: true })).toBeNull();
    expect(validateAgainstSchema({ q: '\u{1F44D}\u{1F44D}' }, long, 'arguments', { bounds: true })).toBe(
      'arguments.q should be at least 3 characters, got 2',
    );
  });

  it('applies a bound only to the kind of value it describes', () => {
    // `maximum` on a string says nothing; an author who wrote one meant maxLength.
    const odd = { type: 'object', properties: { name: { type: 'string', maximum: 3 } } };
    expect(validateAgainstSchema({ name: 'a long name' }, odd, 'arguments', { bounds: true })).toBeNull();
  });

  it('carries strictness into nested properties and array items', () => {
    const nested = {
      type: 'object',
      properties: { page: { type: 'object', properties: { size: { type: 'integer', maximum: 50 } } } },
    };
    expect(validateAgainstSchema({ page: { size: 500 } }, nested, 'arguments', { bounds: true })).toBe(
      'arguments.page.size should be <= 50, got 500',
    );

    const list = { type: 'array', items: { type: 'string', maxLength: 2 } };
    expect(validateAgainstSchema(['ok', 'toolong'], list, 'arguments', { bounds: true })).toBe(
      'arguments[1] should be at most 2 characters, got 7',
    );
  });
});
