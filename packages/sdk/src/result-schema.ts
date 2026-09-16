/**
 * A deliberately small JSON Schema checker, used to decide whether a tool's result
 * matches the shape its owner declared.
 *
 * **Why not a real validator.** This SDK ships with zero runtime dependencies, and
 * adding a JSON Schema library to answer "does this object have the keys it promised"
 * would be a large cost for a small question. The subset below covers what a tool result
 * schema actually uses; anything outside it is ignored rather than rejected, so an
 * unsupported keyword can never manufacture a false failure — which matters because a
 * mismatch is reported to the operator and a feature that cries wolf gets switched off.
 *
 * Kept behaviourally identical to the RESULT path of
 * `apps/api/src/tools/execute/result-schema.ts`. The platform applies it to an `http`
 * tool and this copy applies it to a client-side one; if the two disagreed, the same
 * tool result would pass or fail depending on who ran it.
 *
 * The API copy takes a `bounds` option that additionally enforces `enum`, numeric and
 * string bounds and `additionalProperties`. That is its ARGUMENT path only — checking
 * what a model sent before a request goes out — and it is deliberately not mirrored
 * here: a result is checked leniently on both sides, and a client-side tool's arguments
 * are the host program's own to validate.
 *
 * **Supported:** `type` (including a union array), `required`, `properties`, `items`,
 * `enum`, `nullable`. Composition keywords (`anyOf`, `allOf`, `$ref`), numeric and
 * string bounds, and `additionalProperties` are all ignored on purpose.
 */

/** The subset of JSON Schema keywords {@link validateAgainstSchema} reads. */
interface SubsetSchema {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, SubsetSchema>;
  items?: SubsetSchema;
  enum?: unknown[];
  nullable?: boolean;
}

/** JSON Schema's `type` names, as they map onto runtime values. */
function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** Whether a runtime value satisfies one declared `type` name. */
function matchesType(value: unknown, declared: string): boolean {
  const actual = typeOf(value);
  // An integer is a number; the reverse is not true.
  if (declared === 'number') return actual === 'number' || actual === 'integer';
  return actual === declared;
}

/**
 * Checks a value against a schema, returning the first thing that does not match.
 *
 * One message rather than a list: it is read in a span attribute and in a filter chip,
 * where the first concrete mismatch ("missing required property 'temperature'") is more
 * use than an exhaustive report nobody scrolls.
 *
 * @param value - The tool result, after any `responseTransform`.
 * @param schema - The declared result schema (a plain JSON object).
 * @param path - Dotted path used to build the message; callers pass nothing.
 * @returns `null` when the value matches, otherwise a one-line human-readable reason.
 */
export function validateAgainstSchema(value: unknown, schema: unknown, path = 'result'): string | null {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const s = schema as SubsetSchema;

  if (value === null && s.nullable) return null;

  if (s.type !== undefined) {
    const declared = Array.isArray(s.type) ? s.type : [s.type];
    if (!declared.some((t) => matchesType(value, t))) {
      return `${path} should be ${declared.join(' or ')}, got ${typeOf(value)}`;
    }
  }

  if (s.enum !== undefined && !s.enum.some((allowed) => allowed === value)) {
    return `${path} should be one of ${s.enum.map((v) => JSON.stringify(v)).join(', ')}`;
  }

  if (Array.isArray(value) && s.items) {
    for (let i = 0; i < value.length; i++) {
      const failure = validateAgainstSchema(value[i], s.items, `${path}[${i}]`);
      if (failure) return failure;
    }
    return null;
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of s.required ?? []) {
      if (!(key in obj)) return `${path} is missing required property '${key}'`;
    }
    for (const [key, sub] of Object.entries(s.properties ?? {})) {
      if (key in obj) {
        const failure = validateAgainstSchema(obj[key], sub, `${path}.${key}`);
        if (failure) return failure;
      }
    }
  }

  return null;
}
