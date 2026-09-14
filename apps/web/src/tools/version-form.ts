import type { CommitToolVersionInput, Executor, HttpHeader, ToolVersion } from '@/api';
import type { ParamRow } from './param-schema';
import { rowsToSchema, schemaRejectsUnknown, schemaToRows } from './param-schema';

/** HTTP methods an `http` executor may use, in the order the method `<select>` lists them. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** The blank JSON shown when switching an empty builder to raw-JSON mode. */
export const EMPTY_SCHEMA_TEXT = '{\n  "type": "object",\n  "properties": {}\n}';

/**
 * Everything a tool version's form holds, as plain data.
 *
 * Kept apart from the component so the two things worth getting right — reading a
 * committed version into the form, and turning the form back into a commit body — are
 * pure functions with tests, rather than a hundred lines inside a submit handler where a
 * dropped field goes unnoticed. That is exactly how `failureWhen` and `resultSchema`
 * came to be silently discarded by every dashboard commit.
 */
export interface VersionFormState {
  /** What the model reads. Carried forward from the previous version. */
  description: string;
  /** A note for the team. Never carried forward — see {@link versionFormFromVersion}. */
  changelog: string;
  schemaMode: 'builder' | 'json';
  /** The builder's `additionalProperties: false` checkbox. */
  rejectUnknown: boolean;
  paramRows: ParamRow[];
  schemaText: string;
  executorType: 'client' | 'http';
  url: string;
  method: HttpMethod;
  headers: HttpHeader[];
  query: HttpHeader[];
  requestTransform: string;
  responseTransform: string;
  failureWhen: string;
  /** Raw JSON for the executor's `resultSchema`; blank means the tool declares none. */
  resultSchemaText: string;
  /**
   * `null` means "not set" — the source version carried no `resultSchemaSeverity` and the
   * user has not touched the control. The `<Select>` still needs something to show, so
   * {@link ToolVersionFields} displays `'warn'` for `null`, but {@link versionFormToCommit}
   * must tell the two apart: emitting a default the user never chose is exactly what wrote
   * a stray `resultSchemaSeverity` into every SDK-authored executor that had none. See
   * there for why that key mattering at all.
   */
  resultSchemaSeverity: 'warn' | 'error' | null;
}

/** A blank form — a no-argument `client` tool, the smallest thing that commits. */
export function emptyVersionForm(): VersionFormState {
  return {
    description: '',
    changelog: '',
    schemaMode: 'builder',
    rejectUnknown: false,
    paramRows: [],
    schemaText: EMPTY_SCHEMA_TEXT,
    executorType: 'client',
    url: '',
    method: 'GET',
    headers: [],
    query: [],
    requestTransform: '',
    responseTransform: '',
    failureWhen: '',
    resultSchemaText: '',
    resultSchemaSeverity: null,
  };
}

/**
 * Reads a committed version back into the form, so "New version" starts from what is
 * live instead of blank.
 *
 * `description` IS carried forward: it is what the model reads, so it is configuration
 * like the schema and the executor, and leaving it blank would mean every dashboard
 * commit quietly dropped the tool's purpose from the model's view. `changelog` is
 * deliberately NOT carried forward — a release note describes one commit, and repeating
 * the previous one would be wrong on every version after the first.
 *
 * @param version - The version to start from.
 * @returns A form holding every field the version carries.
 */
export function versionFormFromVersion(version: ToolVersion): VersionFormState {
  const base = emptyVersionForm();
  const rows = schemaToRows(version.parametersSchema);
  const executor = version.executor;

  return {
    ...base,
    description: version.description ?? '',
    ...(rows
      ? { schemaMode: 'builder' as const, paramRows: rows, rejectUnknown: schemaRejectsUnknown(version.parametersSchema) }
      : { schemaMode: 'json' as const, schemaText: JSON.stringify(version.parametersSchema, null, 2) }),
    ...(executor.type === 'http'
      ? {
          executorType: 'http' as const,
          url: executor.url ?? '',
          method: (executor.method ?? 'GET') as HttpMethod,
          headers: executor.headers ?? [],
          query: executor.query ?? [],
          requestTransform: executor.requestTransform ?? '',
          responseTransform: executor.responseTransform ?? '',
          failureWhen: executor.failureWhen ?? '',
          resultSchemaText: executor.resultSchema ? JSON.stringify(executor.resultSchema, null, 2) : '',
          // Carried forward as-is, `undefined` included — see the field's own doc comment
          // for why a UI default must not be written here.
          resultSchemaSeverity: executor.resultSchemaSeverity ?? null,
        }
      : { executorType: 'client' as const }),
  };
}

/** Which field a commit was refused over, so the dialog can put the message beside it. */
export type VersionFormField = 'parameters' | 'resultSchema';

/** Either a body ready to POST, or the field that stopped it and why. */
export type VersionFormResult =
  | { ok: true; body: CommitToolVersionInput }
  | { ok: false; field: VersionFormField; message: string };

/** `JSON.parse` into a plain object, or `undefined` for anything else. */
function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Turns the form into the body for `POST /tools/:id/versions`.
 *
 * Every optional field is omitted rather than sent blank. That is not tidiness:
 * `POST /tools/sync` fingerprints the stored executor to decide whether a spec changed,
 * so a key written for a feature the tool does not use makes the next deploy commit a
 * version for a tool nobody touched.
 *
 * Two server-accepted shapes still do not survive a round trip, both of which change
 * `specFingerprint`: a `resultSchemaSeverity` stored without a `resultSchema` (the emit is
 * gated on the schema), and a `bodyTemplate` stored as an empty string (never re-emitted).
 * Both are dead keys the form has no way to represent, so dropping them is arguably right —
 * but it is a change, so a tool carrying either will commit one extra version the first
 * time it is saved from the dashboard.
 *
 * @param form - The form's current state.
 * @returns The commit body, or the field that must be fixed first.
 */
export function versionFormToCommit(form: VersionFormState): VersionFormResult {
  let parametersSchema: Record<string, unknown>;
  if (form.schemaMode === 'builder') {
    parametersSchema = rowsToSchema(form.paramRows, form.rejectUnknown);
  } else {
    const parsed = parseObject(form.schemaText);
    if (!parsed) {
      return { ok: false, field: 'parameters', message: 'Parameters must be valid JSON (a JSON object).' };
    }
    parametersSchema = parsed;
  }

  let executor: Executor;
  if (form.executorType === 'client') {
    executor = { type: 'client' };
  } else {
    const resultSchemaText = form.resultSchemaText.trim();
    let resultSchema: Record<string, unknown> | undefined;
    if (resultSchemaText.length > 0) {
      resultSchema = parseObject(resultSchemaText);
      if (!resultSchema) {
        return {
          ok: false,
          field: 'resultSchema',
          message: 'The result schema must be valid JSON (a JSON object), or left empty.',
        };
      }
    }

    executor = {
      type: 'http',
      url: form.url.trim(),
      method: form.method,
      headers: form.headers.filter((h) => h.name.trim() !== ''),
      query: form.query.filter((h) => h.name.trim() !== ''),
      ...(form.requestTransform.trim() ? { requestTransform: form.requestTransform.trim() } : {}),
      ...(form.responseTransform.trim() ? { responseTransform: form.responseTransform.trim() } : {}),
      ...(form.failureWhen.trim() ? { failureWhen: form.failureWhen.trim() } : {}),
      // The severity only means something alongside a schema, so it travels with one —
      // and only when it is something: `null` means the source version had none and the
      // user left it alone, so writing the UI's displayed default back in would add a key
      // `POST /tools/sync`'s fingerprint never had, turning an untouched tool into a
      // phantom new version on the next deploy.
      ...(resultSchema
        ? { resultSchema, ...(form.resultSchemaSeverity ? { resultSchemaSeverity: form.resultSchemaSeverity } : {}) }
        : {}),
    };
  }

  return {
    ok: true,
    body: {
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
      ...(form.changelog.trim() ? { changelog: form.changelog.trim() } : {}),
      source: 'dashboard',
      parametersSchema,
      executor,
    },
  };
}

/**
 * Whether the collapsed "failure checks" section should be showing.
 *
 * Derived, not stored. A `useState` initializer reads the form once, on the mount of a
 * dialog that stays mounted between openings — so a section keyed off one starts closed
 * for every version afterwards, including the ones that do carry a failure predicate.
 * The section then said "Show failure checks" over fields that were populated, which
 * reads as "this tool has none".
 *
 * @param override - What the user last clicked, or null if they have not.
 * @param form - Current form state.
 * @returns True when the section should be open.
 */
export function advancedSectionOpen(override: boolean | null, form: VersionFormState): boolean {
  if (override !== null) return override;
  return form.failureWhen.trim() !== '' || form.resultSchemaText.trim() !== '';
}

/** Whether the form holds enough to commit — an `http` executor needs a URL. */
export function canCommitVersionForm(form: VersionFormState): boolean {
  if (form.schemaMode === 'json' && form.schemaText.trim().length === 0) return false;
  return form.executorType === 'client' || form.url.trim().length > 0;
}
