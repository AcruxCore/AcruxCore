import { describe, it, expect } from 'vitest';
import { rowsToSchema, schemaToRows } from './param-schema';
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
  it('unknown top-level key (e.g. additionalProperties)', () => {
    expect(
      schemaToRows({ type: 'object', properties: {}, additionalProperties: false }),
    ).toBeNull();
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
