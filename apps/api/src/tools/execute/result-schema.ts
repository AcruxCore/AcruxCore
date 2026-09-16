/**
 * A deliberately small JSON Schema checker, used to decide whether a tool's result
 * matches the shape its owner declared.
 *
 * **Why not a real validator.** `apps/api` has no JSON Schema dependency, and adding
 * one (ajv pulls in a code generator and its own compile step) to answer "does this
 * object have the keys it promised" is a poor trade. The subset below covers what a
 * tool result schema actually uses; anything outside it is ignored rather than
 * rejected, so an unsupported keyword can never manufacture a false failure — which
 * matters because a mismatch is reported to the operator and a feature that cries wolf
 * gets switched off.
 *
 * **Supported:** `type` (including a union array), `required`, `properties`, `items`,
 * `enum`, `nullable`, and — only when the caller opts in via `{ bounds: true }` —
 * `minimum`, `maximum`, `minLength`, `maxLength` and `additionalProperties: false`.
 * Composition keywords (`anyOf`, `allOf`, `$ref`) are ignored on purpose.
 *
 * **Why bounds are opt-in.** The two callers want different strictness. A tool
 * *result* is checked to warn an operator, so a false alarm is worse than a
 * missed one and the bounds stay off. A tool's *arguments* are filled by a
 * model and forwarded to the author's own upstream service, so the author's
 * `maximum: 10` is a real limit and silently exceeding it is the failure
 * (issue #506).
 */

/** The subset of JSON Schema keywords {@link validateAgainstSchema} reads. */
interface SubsetSchema {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, SubsetSchema>;
  items?: SubsetSchema;
  enum?: unknown[];
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  additionalProperties?: boolean | Record<string, unknown>;
}

/** How strict one {@link validateAgainstSchema} call is. See the file header. */
export interface SchemaCheckOptions {
  /**
   * Also enforce `minimum`/`maximum`/`minLength`/`maxLength` and
   * `additionalProperties: false`. Off by default, so the result-checking
   * caller keeps the deliberately lenient behaviour it was written with.
   */
  bounds?: boolean;
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
 * @param value - The value to check: a tool result, or a tool's arguments.
 * @param schema - The declared schema (a plain JSON object).
 * @param path - Dotted path used to build the message; callers pass a root label.
 * @param options - Strictness; see {@link SchemaCheckOptions}.
 * @returns `null` when the value matches, otherwise a one-line human-readable reason.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: unknown,
  path = 'result',
  options: SchemaCheckOptions = {},
): string | null {
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

  if (options.bounds) {
    const boundsFailure = checkBounds(value, s, path);
    if (boundsFailure) return boundsFailure;
  }

  if (Array.isArray(value) && s.items) {
    for (let i = 0; i < value.length; i++) {
      const failure = validateAgainstSchema(value[i], s.items, `${path}[${i}]`, options);
      if (failure) return failure;
    }
    return null;
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of s.required ?? []) {
      if (!(key in obj)) return `${path} is missing required property '${key}'`;
    }
    // No `&& s.properties` guard: `{type:'object', additionalProperties:false}` with no
    // `properties` key is the STRICTEST spelling there is — it declares nothing and
    // allows nothing — so requiring the key made the strict form the one that accepted
    // anything, while the identical intent written as `properties:{}` was enforced.
    if (options.bounds && s.additionalProperties === false) {
      const declared = new Set(Object.keys(s.properties ?? {}));
      const extra = Object.keys(obj).find((key) => !declared.has(key));
      if (extra !== undefined) {
        return `${path} does not allow the property '${extra}'`;
      }
    }
    for (const [key, sub] of Object.entries(s.properties ?? {})) {
      if (key in obj) {
        const failure = validateAgainstSchema(obj[key], sub, `${path}.${key}`, options);
        if (failure) return failure;
      }
    }
  }

  return null;
}

/**
 * Checks the numeric and string bounds on one value. Split out so the
 * lenient (result) path never pays for keywords it deliberately ignores.
 *
 * Each bound only applies to the kind of value it describes: a `maximum` on a
 * string is meaningless, not a failure, and an author who wrote one meant
 * `maxLength`.
 */
function checkBounds(value: unknown, s: SubsetSchema, path: string): string | null {
  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) return `${path} should be >= ${s.minimum}, got ${value}`;
    if (s.maximum !== undefined && value > s.maximum) return `${path} should be <= ${s.maximum}, got ${value}`;
  }
  if (typeof value === 'string') {
    // Characters, not UTF-16 code units. JSON Schema counts `minLength`/`maxLength` in
    // characters, and `String.prototype.length` counts code units — so an emoji or any
    // other astral character counted double, and a three-character argument was refused
    // as six in a message that said "characters". A false rejection here now ends the
    // whole tool call, which makes the difference user-visible rather than pedantic.
    const chars = [...value].length;
    if (s.minLength !== undefined && chars < s.minLength) {
      return `${path} should be at least ${s.minLength} characters, got ${chars}`;
    }
    if (s.maxLength !== undefined && chars > s.maxLength) {
      return `${path} should be at most ${s.maxLength} characters, got ${chars}`;
    }
  }
  return null;
}
