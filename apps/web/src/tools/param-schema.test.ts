import { describe, it, expect } from 'vitest';
import { builderAvailability, rowsToSchema, schemaRejectsUnknown, schemaToRows } from './param-schema';
import type { ParamRow } from './param-schema';

describe('rowsToSchema', () => {
  it('builds an object schema with properties and required', () => {
    const rows: ParamRow[] = [
      { name: 'q', type: 'string', description: 'City name', required: true },
      { name: 'days', type: 'integer', description: '', required: false },
    ];
    expect(rowsToSchema(rows)).toEqual({
      type: 'object',
      properties: {
        q: { type: 'string', description: 'City name' },
        days: { type: 'integer' },
      },
      required: ['q'],
    });
  });

  it('omits required entirely when no row is required, and skips blank names', () => {
    const rows: ParamRow[] = [
      { name: '', type: 'string', description: 'ignored', required: true },
      { name: 'x', type: 'boolean', description: '', required: false },
    ];
    expect(rowsToSchema(rows)).toEqual({ type: 'object', properties: { x: { type: 'boolean' } } });
  });
});

describe('schemaToRows — representable', () => {
  it('round-trips a simple schema back into rows', () => {
    const schema = {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'City name' },
        days: { type: 'integer' },
      },
      required: ['q'],
    };
    expect(schemaToRows(schema)).toEqual([
      { name: 'q', type: 'string', description: 'City name', required: true },
      { name: 'days', type: 'integer', description: '', required: false },
    ]);
  });

  it('treats an absent properties key as no rows', () => {
    expect(schemaToRows({ type: 'object' })).toEqual([]);
  });
});

describe('schemaToRows — bails to null (stays JSON) for anything it cannot round-trip', () => {
  it('enum on a property', () => {
    expect(
      schemaToRows({ type: 'object', properties: { u: { type: 'string', enum: ['c', 'f'] } } }),
    ).toBeNull();
  });
  it('numeric constraints like minimum', () => {
    expect(
      schemaToRows({ type: 'object', properties: { n: { type: 'number', minimum: 0 } } }),
    ).toBeNull();
  });
  it('nested object property', () => {
    expect(
      schemaToRows({ type: 'object', properties: { o: { type: 'object', properties: {} } } }),
    ).toBeNull();
  });
  it('array-typed property', () => {
    expect(schemaToRows({ type: 'object', properties: { a: { type: 'array' } } })).toBeNull();
  });
  it('an unknown top-level key, e.g. a title or a $schema', () => {
    expect(schemaToRows({ type: 'object', properties: {}, title: 'Args' })).toBeNull();
    expect(schemaToRows({ type: 'object', properties: {}, $schema: 'https://json-schema.org/' })).toBeNull();
  });
  it('required naming a property that is not declared', () => {
    expect(
      schemaToRows({ type: 'object', properties: { q: { type: 'string' } }, required: ['q', 'ghost'] }),
    ).toBeNull();
  });
  it('a non-object schema', () => {
    expect(schemaToRows({ type: 'string' })).toBeNull();
    expect(schemaToRows(null)).toBeNull();
    expect(schemaToRows([])).toBeNull();
  });
});

describe('builderAvailability — why the "Back to builder" toggle is usable or not', () => {
  it('is ready for a schema the rows can round-trip', () => {
    expect(
      builderAvailability('{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}'),
    ).toBe('ready');
  });

  it('is ready for an empty box, so clearing it returns to an empty builder', () => {
    expect(builderAvailability('')).toBe('ready');
    expect(builderAvailability('   \n ')).toBe('ready');
  });

  it('reports invalid-json rather than pretending the builder could open', () => {
    expect(builderAvailability('{"type":')).toBe('invalid-json');
  });

  it('reports unrepresentable for an additionalProperties the rows cannot re-emit', () => {
    expect(
      builderAvailability('{"type":"object","properties":{"city":{"type":"string"}},"additionalProperties":true}'),
    ).toBe('unrepresentable');
  });

  it('reports unrepresentable for enum, minimum and nested objects', () => {
    expect(builderAvailability('{"type":"object","properties":{"u":{"type":"string","enum":["c"]}}}')).toBe(
      'unrepresentable',
    );
    expect(builderAvailability('{"type":"object","properties":{"n":{"type":"number","minimum":0}}}')).toBe(
      'unrepresentable',
    );
    expect(
      builderAvailability('{"type":"object","properties":{"o":{"type":"object","properties":{}}}}'),
    ).toBe('unrepresentable');
  });
});

describe('additionalProperties: false is a builder feature, not a JSON-only one', () => {
  it('rowsToSchema emits it when unknown arguments are rejected', () => {
    const rows: ParamRow[] = [{ name: 'city', type: 'string', description: '', required: true }];
    expect(rowsToSchema(rows, true)).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    });
  });

  it('rowsToSchema leaves it out by default', () => {
    const rows: ParamRow[] = [{ name: 'city', type: 'string', description: '', required: false }];
    expect(rowsToSchema(rows)).not.toHaveProperty('additionalProperties');
  });

  it('schemaToRows accepts a schema that only adds additionalProperties: false', () => {
    expect(
      schemaToRows({
        type: 'object',
        properties: { city: { type: 'string', description: 'A city.' } },
        required: ['city'],
        additionalProperties: false,
      }),
    ).toEqual([{ name: 'city', type: 'string', description: 'A city.', required: true }]);
  });

  it('schemaRejectsUnknown reads the flag back', () => {
    expect(schemaRejectsUnknown({ type: 'object', properties: {}, additionalProperties: false })).toBe(true);
    expect(schemaRejectsUnknown({ type: 'object', properties: {} })).toBe(false);
  });

  it('still bails on additionalProperties: true, which the rows cannot re-emit', () => {
    expect(schemaToRows({ type: 'object', properties: {}, additionalProperties: true })).toBeNull();
  });

  it('still bails on a schema-valued additionalProperties', () => {
    expect(
      schemaToRows({ type: 'object', properties: {}, additionalProperties: { type: 'string' } }),
    ).toBeNull();
  });

  it('the tutorial tools can now go back to the builder', () => {
    expect(
      builderAvailability(
        '{"type":"object","required":["city"],"properties":{"city":{"type":"string"}},"additionalProperties":false}',
      ),
    ).toBe('ready');
  });

  it('round-trips rows -> schema -> rows with the flag on', () => {
    const rows: ParamRow[] = [
      { name: 'amount', type: 'number', description: 'How much.', required: true },
      { name: 'to', type: 'string', description: 'ISO code.', required: true },
    ];
    const schema = rowsToSchema(rows, true);
    expect(schemaToRows(schema)).toEqual(rows);
    expect(schemaRejectsUnknown(schema)).toBe(true);
  });
});
