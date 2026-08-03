import { acruxcoreError } from './error';
import { isZodV4Schema, loadZodToJsonSchema } from './tools';
import type { ResponseFormat } from './types';

/**
 * Resolves a {@link ResponseFormat} into the OpenAI-shaped wire dict the gateway forwards
 * to the provider. The `{ zod, name }` form is converted here by importing zod dynamically
 * (it is an optional peer dependency) and calling `toJSONSchema`; every other form passes
 * straight through unchanged.
 *
 * Mirrors `resolveParametersSchema` in `tools.ts` — same dynamic-import discipline, same
 * zod v3-vs-v4 guard, same error codes. Run this ONCE at the public entrypoint of `chat()`
 * / `runToolLoop()` so the rest of the pipeline (the synchronous `_buildChatBody`) only
 * ever sees the plain wire dict.
 *
 * @param responseFormat - The caller's `ResponseFormat`, or `undefined`.
 * @returns The resolved OpenAI-shaped dict, or `undefined` when none was given.
 * @throws {acruxcoreError} `ZOD_NOT_AVAILABLE` if a zod schema was given but zod cannot be
 *   imported; `TOOL_SCHEMA_ERROR` if it is a classic zod v3 schema.
 */
export async function resolveResponseFormat(
  responseFormat: ResponseFormat | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (!responseFormat) return undefined;
  // The `{ zod, name }` arm is the only one that needs conversion.
  if ('zod' in responseFormat) {
    if (!isZodV4Schema(responseFormat.zod)) {
      throw new acruxcoreError(
        'acruxcore: this looks like a classic zod v3 schema, which cannot be converted to JSON ' +
          "Schema. Import zod's v4 API instead — `import { z } from 'zod/v4'` on zod 3.25+, or " +
          "`import { z } from 'zod'` on zod 4 — or pass a plain { type: 'json_schema', ... } " +
          'object as `responseFormat` instead.',
        'TOOL_SCHEMA_ERROR',
      );
    }
    const toJSONSchema = await loadZodToJsonSchema();
    const schema = toJSONSchema(responseFormat.zod) as Record<string, unknown>;
    const { $schema: _ignored, ...rest } = schema;
    return {
      type: 'json_schema',
      json_schema: { name: responseFormat.name, schema: rest, strict: responseFormat.strict ?? true },
    };
  }
  // The text / json_object / json_schema forms are already the wire shape.
  return responseFormat as Record<string, unknown>;
}
