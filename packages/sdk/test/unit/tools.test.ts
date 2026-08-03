import { describe, it, expect, vi } from 'vitest';
// zod's v4 API: `toJSONSchema` only understands v4 schemas, and zod 3.25 ships both
// APIs side by side. On zod 4 proper this is just `from 'zod'`.
import { z } from 'zod/v4';
import { z as zodV3 } from 'zod';
import { acrux, tool, isAcruxTool, resolveParametersSchema, parseToolArgs } from '../../src/tools';
import { acruxcoreError } from '../../src/error';

describe('acrux.tool', () => {
  it('carries the declared name, description, alias and a client executor', () => {
    const getWeather = acrux.tool(
      {
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        parameters: z.object({ city: z.string() }),
        alias: 'staging',
        changelog: 'v2 - added units',
      },
      async () => ({ tempC: 18 }),
    );

    expect(isAcruxTool(getWeather)).toBe(true);
    expect(getWeather.name).toBe('get_weather');
    expect(getWeather.description).toBe('Get the current weather for a city.');
    expect(getWeather.alias).toBe('staging');
    expect(getWeather.changelog).toBe('v2 - added units');
    expect(getWeather.executor).toEqual({ type: 'client' });
  });

  it('defaults the alias to production', () => {
    const t = tool({ name: 'noop', parameters: { type: 'object', properties: {} } }, () => null);
    expect(t.alias).toBe('production');
  });

  it('rejects a name the model-facing API would refuse', () => {
    expect(() =>
      tool({ name: 'not a valid name!', parameters: { type: 'object', properties: {} } }, () => null),
    ).toThrowError(acruxcoreError);
  });

  it('converts a zod schema to JSON Schema, keeping .describe() text', async () => {
    const t = tool(
      {
        name: 'get_weather',
        parameters: z.object({ city: z.string().describe("City name, e.g. 'London'") }),
      },
      async () => null,
    );
    const schema = await resolveParametersSchema(t.parameters);
    expect(schema['type']).toBe('object');
    expect(schema['properties']).toMatchObject({
      city: { type: 'string', description: "City name, e.g. 'London'" },
    });
    expect(schema['required']).toEqual(['city']);
    // $schema is stripped: it is noise in a tool definition and the API stores this
    // object verbatim as parametersSchema.
    expect(schema).not.toHaveProperty('$schema');
  });

  it('passes a plain JSON Schema through untouched', async () => {
    const raw = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
    const t = tool({ name: 'get_weather', parameters: raw }, async () => null);
    expect(await resolveParametersSchema(t.parameters)).toEqual(raw);
  });

  it('rejects parameters that are neither zod-like nor an object schema', async () => {
    const t = tool(
      { name: 'get_weather', parameters: 42 as unknown as Record<string, unknown> },
      async () => null,
    );
    await expect(resolveParametersSchema(t.parameters)).rejects.toThrowError(acruxcoreError);
  });

  it('throws ZOD_NOT_AVAILABLE when a zod schema is given but zod cannot be imported', async () => {
    // zod IS installed here (it is a devDependency), so the only way to exercise the
    // real failure a consumer hits is to make both dynamic-import specifiers fail.
    vi.doMock('zod/v4', () => {
      throw new Error('not installed');
    });
    vi.doMock('zod', () => {
      throw new Error('not installed');
    });
    vi.resetModules();
    const fresh = await import('../../src/tools');
    const zodLike = { parse: (v: unknown) => v };
    await expect(fresh.resolveParametersSchema(zodLike)).rejects.toMatchObject({
      code: 'ZOD_NOT_AVAILABLE',
    });
    vi.doUnmock('zod/v4');
    vi.doUnmock('zod');
    vi.resetModules();
  });

  it('parses and narrows arguments through a zod schema', () => {
    const t = tool(
      { name: 'get_weather', parameters: z.object({ city: z.string() }) },
      async ({ city }) => city,
    );
    expect(parseToolArgs(t, { city: 'London' })).toEqual({ city: 'London' });
    // A zod schema is a validator as well as a schema, so a bad call fails here
    // rather than inside the handler with an unhelpful runtime error.
    expect(() => parseToolArgs(t, { city: 42 })).toThrowError();
  });

  it('passes arguments straight through when parameters are a raw JSON Schema', () => {
    const t = tool(
      { name: 'get_weather', parameters: { type: 'object', properties: {} } },
      async () => null,
    );
    expect(parseToolArgs(t, { anything: 1 })).toEqual({ anything: 1 });
  });

  it('gives the handler typed arguments from a zod schema', async () => {
    const t = tool(
      { name: 'get_weather', parameters: z.object({ city: z.string(), days: z.number() }) },
      async ({ city, days }) => `${city.toUpperCase()}:${days.toFixed(0)}`,
    );
    expect(await t.handler({ city: 'london', days: 3 })).toBe('LONDON:3');
  });

  it('names the zod v3-vs-v4 mismatch instead of failing inside zod', async () => {
    // A classic v3 schema reaches toJSONSchema and dies on "reading 'def'", which tells
    // a caller nothing about what to change.
    const t = tool(
      { name: 'get_weather', parameters: zodV3.object({ city: zodV3.string() }) },
      async () => null,
    );
    await expect(resolveParametersSchema(t.parameters)).rejects.toMatchObject({
      code: 'TOOL_SCHEMA_ERROR',
    });
    await expect(resolveParametersSchema(t.parameters)).rejects.toThrowError(/zod\/v4/);
  });

  it('isAcruxTool rejects plain objects and raw tool definitions', () => {
    expect(isAcruxTool({ name: 'get_weather' })).toBe(false);
    expect(isAcruxTool({ type: 'function', function: { name: 'get_weather' } })).toBe(false);
    expect(isAcruxTool(null)).toBe(false);
  });
});
