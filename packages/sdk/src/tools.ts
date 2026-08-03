import { acruxcoreError } from './error';

/** The function name the model sees — same constraint the API enforces. */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Structural stand-in for a zod object schema.
 *
 * Typed by `parse`'s return rather than by importing `z.ZodType`, because zod is an
 * OPTIONAL dependency — a real import would make it mandatory for everyone. Passing
 * `z.object({ city: z.string() })` here infers `T` as `{ city: string }`, which is
 * what gives the handler typed arguments.
 */
export interface ZodLikeSchema<T> {
  parse(value: unknown): T;
}

/** Fields shared by both `tool()` overloads. */
interface ToolInputBase {
  /** The function name the model calls. Must match `^[a-zA-Z0-9_-]{1,64}$`. */
  name: string;
  /** What the tool does. **This is what the model reads.** */
  description?: string;
  /** Which catalog alias a sync moves. Defaults to `production`. */
  alias?: string;
  /** Release note for humans. Never shown to the model. */
  changelog?: string;
}

/**
 * A tool: its interface and the function that implements it, in one value.
 *
 * `parameters` is kept in the shape it was given rather than pre-converted, because
 * converting a zod schema needs a dynamic `import('zod')` and `tool()` is synchronous.
 * The conversion happens in {@link resolveParametersSchema}, called by `tools.sync`.
 */
export interface AcruxTool<A = Record<string, unknown>> {
  /** Brand, so a tool can be told apart from a raw OpenAI definition at runtime. */
  readonly __acruxTool: true;
  readonly name: string;
  readonly description?: string;
  /** A zod schema or a plain JSON Schema object. */
  readonly parameters: unknown;
  readonly alias: string;
  readonly changelog?: string;
  /**
   * Always `{ type: 'client' }`. `tool()` wraps a JavaScript function, so the caller's
   * process is by definition what runs it; `http` executors are a dashboard/API concern.
   */
  readonly executor: { type: 'client' };
  /** Receives parsed, typed arguments. */
  readonly handler: (args: A) => Promise<unknown> | unknown;
}

/**
 * Declares a tool whose parameters are a zod schema, giving the handler typed arguments.
 *
 * Omitting `description` hands ownership of the model-facing text to the dashboard:
 * `tools.sync` sends no description, so the catalog carries the existing one forward
 * rather than clearing it.
 *
 * @param input - Name, optional description/alias/changelog, and a zod object schema.
 * @param handler - The implementation. Its `args` are typed from the schema, so a
 *   renamed parameter is a compile error rather than a silent `undefined`.
 * @returns An {@link AcruxTool} to pass to `runToolLoop({ tools: [...] })`.
 * @throws {acruxcoreError} TOOL_SCHEMA_ERROR if `name` is not a valid tool name.
 */
export function tool<T>(
  input: ToolInputBase & { parameters: ZodLikeSchema<T> },
  handler: (args: T) => Promise<unknown> | unknown,
): AcruxTool<T>;
/**
 * Declares a tool whose parameters are a plain JSON Schema object.
 *
 * Use this when zod is not available or the schema uses JSON Schema features zod
 * cannot express. Arguments reach the handler unvalidated and untyped — that is the
 * cost of not going through a schema that can parse.
 *
 * @param input - Name, optional description/alias/changelog, and a JSON Schema object.
 * @param handler - The implementation, receiving the model's parsed JSON arguments.
 * @returns An {@link AcruxTool}.
 * @throws {acruxcoreError} TOOL_SCHEMA_ERROR if `name` is not a valid tool name.
 */
export function tool(
  input: ToolInputBase & { parameters: Record<string, unknown> },
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown,
): AcruxTool<Record<string, unknown>>;
export function tool(
  input: ToolInputBase & { parameters: unknown },
  handler: (args: never) => Promise<unknown> | unknown,
): AcruxTool<never> {
  if (!TOOL_NAME_PATTERN.test(input.name)) {
    throw new acruxcoreError(
      `acruxcore: tool name "${input.name}" must match ^[a-zA-Z0-9_-]{1,64}$ — this is the ` +
        'constraint OpenAI, Anthropic and Gemini all put on a function name.',
      'TOOL_SCHEMA_ERROR',
    );
  }
  return {
    __acruxTool: true,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    parameters: input.parameters,
    alias: input.alias ?? 'production',
    ...(input.changelog !== undefined ? { changelog: input.changelog } : {}),
    executor: { type: 'client' },
    handler: handler as (args: never) => Promise<unknown> | unknown,
  };
}

/** Namespace so the decorator-ish spelling `acrux.tool({...}, fn)` reads the same in both SDKs. */
export const acrux = { tool };

/**
 * True when `value` came from {@link tool}.
 *
 * @param value - Anything.
 * @returns Whether it is an {@link AcruxTool}.
 */
export function isAcruxTool(value: unknown): value is AcruxTool<never> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __acruxTool?: unknown }).__acruxTool === true
  );
}

/** True for something with a `parse` method — i.e. a zod schema, structurally. */
function isZodLike(value: unknown): value is ZodLikeSchema<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { parse?: unknown }).parse === 'function'
  );
}

/**
 * True for a zod **v4** schema, which is the only kind `z.toJSONSchema` can convert.
 *
 * zod 3.25 ships both APIs side by side: `from 'zod'` gives the classic v3 schema
 * (`_def`), `from 'zod/v4'` gives the new one (`_zod`). Handing a v3 schema to
 * `toJSONSchema` fails deep inside zod with "Cannot read properties of undefined
 * (reading 'def')", which tells a caller nothing — hence this check.
 */
export function isZodV4Schema(value: unknown): boolean {
  return typeof value === 'object' && value !== null && '_zod' in (value as object);
}

/**
 * Converts a tool's `parameters` into the JSON Schema object the catalog stores.
 *
 * Zod is imported dynamically, never at the top level: it is an optional peer
 * dependency, and a static import would make every consumer install it. `zod/v4` is
 * tried first because `toJSONSchema` lives there in the 3.25+ line; plain `zod` is the
 * fallback for zod 4 proper.
 *
 * @param parameters - A zod v4 schema or a JSON Schema object.
 * @returns The JSON Schema object, with `$schema` stripped.
 * @throws {acruxcoreError} ZOD_NOT_AVAILABLE if a zod schema was given but zod cannot
 *   be imported; TOOL_SCHEMA_ERROR if `parameters` is a classic zod v3 schema, or is
 *   neither a zod schema nor an object.
 */
export async function resolveParametersSchema(
  parameters: unknown,
): Promise<Record<string, unknown>> {
  if (isZodLike(parameters)) {
    const toJSONSchema = await loadZodToJsonSchema();
    if (!isZodV4Schema(parameters)) {
      throw new acruxcoreError(
        'acruxcore: this looks like a classic zod v3 schema, which cannot be converted to JSON ' +
          "Schema. Import zod's v4 API instead — `import { z } from 'zod/v4'` on zod 3.25+, or " +
          "`import { z } from 'zod'` on zod 4 — or pass a plain JSON Schema object as `parameters`.",
        'TOOL_SCHEMA_ERROR',
      );
    }
    const schema = toJSONSchema(parameters) as Record<string, unknown>;
    const { $schema: _ignored, ...rest } = schema;
    return rest;
  }
  if (typeof parameters === 'object' && parameters !== null && !Array.isArray(parameters)) {
    return parameters as Record<string, unknown>;
  }
  throw new acruxcoreError(
    "acruxcore: a tool's `parameters` must be a zod object schema or a JSON Schema object, " +
      `received ${typeof parameters}.`,
    'TOOL_SCHEMA_ERROR',
  );
}

/** Resolves zod's `toJSONSchema` through whichever entry point this install exposes. */
export async function loadZodToJsonSchema(): Promise<(schema: unknown) => unknown> {
  for (const specifier of ['zod/v4', 'zod']) {
    try {
      const mod = (await import(specifier)) as {
        z?: { toJSONSchema?: unknown };
        toJSONSchema?: unknown;
      };
      const fn = mod.z?.toJSONSchema ?? mod.toJSONSchema;
      if (typeof fn === 'function') return fn as (schema: unknown) => unknown;
    } catch {
      // Try the next entry point; the throw below reports the overall failure.
    }
  }
  throw new acruxcoreError(
    'acruxcore: a zod schema was passed to tool(), but zod could not be imported. Install zod ' +
      '(>=3.25) alongside the SDK, or pass a plain JSON Schema object as `parameters` instead.',
    'ZOD_NOT_AVAILABLE',
  );
}

/**
 * Validates and narrows the model's arguments before they reach a tool's handler.
 *
 * A zod schema is a validator as well as a schema, so using it here turns a bad model
 * argument into one clear error at the boundary instead of an unhelpful failure deep
 * inside the handler. A raw JSON Schema cannot validate without a validator library,
 * so those arguments pass through unchanged.
 *
 * @param t - The tool whose handler is about to be called.
 * @param args - The model's parsed JSON arguments.
 * @returns The arguments, parsed by the schema when one can parse.
 * @throws Whatever the zod schema throws on invalid input.
 */
export function parseToolArgs<A>(t: AcruxTool<A>, args: Record<string, unknown>): A {
  if (isZodLike(t.parameters)) return (t.parameters as ZodLikeSchema<A>).parse(args);
  return args as unknown as A;
}
