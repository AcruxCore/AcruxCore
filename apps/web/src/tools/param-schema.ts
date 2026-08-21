/**
 * Two-way bridge between a JSON Schema `parametersSchema` object and the flat
 * row model the {@link CommitVersionDialog} parameter builder edits. The wire
 * format is always JSON Schema (that's what the LLM tool-calling API needs) —
 * the builder is only an ergonomic front-end for the common case, so users
 * don't hand-write `{"type":"object","properties":{…}}`.
 *
 * `schemaToRows` is deliberately STRICT: it returns `null` (→ the dialog stays
 * in raw-JSON mode) unless the schema is *fully* representable by a row table.
 * This matters because the New-version dialog feeds an existing version's
 * schema back into the builder — a lenient parser would silently drop
 * constraints it can't render (enum, minimum, nested objects, …) on resave.
 */

/** The four primitive JSON Schema types the row builder can express. */
export type ParamType = 'string' | 'number' | 'integer' | 'boolean';

/** All primitive types, in the order the type <select> lists them. */
export const PARAM_TYPES: ParamType[] = ['string', 'number', 'integer', 'boolean'];

/** One editable parameter row in the builder. */
export interface ParamRow {
  name: string;
  type: ParamType;
  description: string;
  required: boolean;
}

/** True for a non-null, non-array object literal. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Compile builder rows into a JSON Schema object. Blank-named rows are
 * skipped; `required` is omitted entirely when no row is marked required.
 *
 * @param rows - The builder's current rows.
 * @param rejectUnknown - Emit `additionalProperties: false`, so the model may send
 *   only the listed arguments. Off by default, which leaves the key out entirely
 *   rather than writing `true` — an absent key is the JSON Schema default.
 * @returns A JSON Schema object of shape
 *   `{ type: 'object', properties, required?, additionalProperties? }`.
 */
export function rowsToSchema(rows: ParamRow[], rejectUnknown = false): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    const prop: Record<string, unknown> = { type: row.type };
    const description = row.description.trim();
    if (description) prop.description = description;
    properties[name] = prop;
    if (row.required) required.push(name);
  }
  const schema: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  if (rejectUnknown) schema.additionalProperties = false;
  return schema;
}

/**
 * Parse a JSON Schema object into builder rows, or return `null` if it uses
 * anything the builder can't round-trip losslessly.
 *
 * Representable means: the top level has only `type`/`properties`/`required`,
 * plus `additionalProperties` when it is exactly `false` (the builder shows that
 * as a checkbox — read it with {@link schemaRejectsUnknown}), with
 * `type === 'object'`; every property object has only `type` (one of the four
 * primitives) plus an optional string `description`; and every name in
 * `required` is a declared property. Anything else → `null`.
 *
 * @param schema - The parsed `parametersSchema` value (unknown shape).
 * @returns The equivalent rows, or `null` to signal "edit as raw JSON instead".
 */
export function schemaToRows(schema: unknown): ParamRow[] | null {
  if (!isPlainObject(schema)) return null;

  const allowedTop = new Set(['type', 'properties', 'required', 'additionalProperties']);
  if (Object.keys(schema).some((k) => !allowedTop.has(k))) return null;
  if (schema.type !== 'object') return null;
  // Only `false` is representable: the builder re-emits it from a checkbox. `true`
  // or a sub-schema would be dropped on resave, so those still force JSON mode.
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) return null;

  // `properties` may be absent (a no-argument tool) — treat as empty.
  const properties = schema.properties ?? {};
  if (!isPlainObject(properties)) return null;
  const propertyNames = new Set(Object.keys(properties));

  let requiredSet: Set<string>;
  if (schema.required === undefined) {
    requiredSet = new Set();
  } else if (Array.isArray(schema.required) && schema.required.every((r) => typeof r === 'string')) {
    requiredSet = new Set(schema.required as string[]);
  } else {
    return null;
  }
  // A `required` entry with no matching property can't be shown as a row —
  // bail to JSON mode rather than silently dropping it.
  for (const name of requiredSet) {
    if (!propertyNames.has(name)) return null;
  }

  const allowedProp = new Set(['type', 'description']);
  const rows: ParamRow[] = [];
  for (const [name, value] of Object.entries(properties)) {
    if (!isPlainObject(value)) return null;
    if (Object.keys(value).some((k) => !allowedProp.has(k))) return null;
    const type = value.type;
    if (type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean') return null;
    if (value.description !== undefined && typeof value.description !== 'string') return null;
    rows.push({
      name,
      type,
      description: (value.description as string | undefined) ?? '',
      required: requiredSet.has(name),
    });
  }
  return rows;
}

/**
 * Why the row builder can or cannot take over the schema currently being edited
 * as raw JSON: `'ready'` (the rows can hold it losslessly), `'invalid-json'`
 * (the text does not parse), or `'unrepresentable'` (it parses, but uses a
 * feature the rows cannot show — `enum`, `minimum`, a nested object,
 * `additionalProperties`, …).
 */
export type BuilderAvailability = 'ready' | 'invalid-json' | 'unrepresentable';

/**
 * Classifies raw-JSON schema text for the "Back to builder" toggle, so the UI can
 * disable the toggle and say why instead of leaving a click with no visible effect.
 *
 * Blank text counts as `'ready'`: clearing the box and returning to an empty
 * builder is a reasonable thing to want, and refusing it would strand the user in
 * JSON mode.
 *
 * @param schemaText - The current contents of the raw-JSON editor.
 * @returns Whether switching to the builder would work, and if not, which reason
 *   to show.
 */
export function builderAvailability(schemaText: string): BuilderAvailability {
  if (schemaText.trim().length === 0) return 'ready';
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaText);
  } catch {
    return 'invalid-json';
  }
  return schemaToRows(parsed) === null ? 'unrepresentable' : 'ready';
}

/**
 * Whether a schema forbids arguments it does not list, i.e. carries
 * `additionalProperties: false`. Pairs with `rowsToSchema(rows, rejectUnknown)`
 * so the builder's checkbox survives a round trip through JSON.
 *
 * @param schema - The parsed `parametersSchema` value (unknown shape).
 * @returns `true` only for an explicit `additionalProperties: false`.
 */
export function schemaRejectsUnknown(schema: unknown): boolean {
  return isPlainObject(schema) && schema.additionalProperties === false;
}
