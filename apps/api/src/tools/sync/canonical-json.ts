/**
 * Serialises a JSON value with every object's keys sorted, at every depth, so two
 * structurally identical values always produce the same string.
 *
 * `POST /tools/sync` uses this to decide whether a submitted spec differs from the
 * live one. Without it, a caller whose JSON serialiser happened to emit
 * `{"required":[...],"type":"object"}` instead of `{"type":"object","required":[...]}`
 * would commit a new tool version on every deploy — the schema is the same, only the
 * byte order changed.
 *
 * Array order is preserved deliberately: `required: ['a','b']` and `required: ['b','a']`
 * are the same set to a JSON Schema validator, but treating arrays as unordered here
 * would mean ignoring a real edit in the general case (`enum` members, `items` tuples),
 * so order-sensitivity is the safer default.
 *
 * @param value - Any JSON-serialisable value. `undefined` object properties are
 *   dropped, matching `JSON.stringify`, so an omitted field and an explicit
 *   `undefined` compare equal (an explicit `null` does not).
 * @returns A deterministic JSON string.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/** Recursively rebuilds objects with sorted keys; arrays and primitives pass through. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = sortDeep(source[key]);
  }
  return out;
}
