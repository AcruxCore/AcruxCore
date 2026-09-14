import { useMemo, useState } from 'react';
import type { HttpHeader } from '@/api';
import { Field, Input, Select, Textarea } from '@/ui';
import type { ParamRow, ParamType } from './param-schema';
import { PARAM_TYPES, builderAvailability, rowsToSchema, schemaRejectsUnknown, schemaToRows } from './param-schema';
import type { VersionFormField, VersionFormState } from './version-form';
import { EMPTY_SCHEMA_TEXT, HTTP_METHODS, advancedSectionOpen } from './version-form';

/** One editable name/value row (used for both headers and query params). */
interface KeyValueRowsProps {
  label: string;
  hint?: string;
  rows: HttpHeader[];
  onChange: (rows: HttpHeader[]) => void;
}

/**
 * A labeled, repeatable list of name/value inputs — the shared editor for an `http`
 * executor's `headers` and `query` arrays.
 */
function KeyValueRows({ label, hint, rows, onChange }: KeyValueRowsProps) {
  function update(index: number, field: keyof HttpHeader, value: string) {
    onChange(rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        <button
          type="button"
          className="text-[12px] text-accent hover:underline"
          onClick={() => onChange([...rows, { name: '', value: '' }])}
        >
          Add {label.toLowerCase().replace(/s$/, '')}
        </button>
      </div>
      {hint && <p className="text-[12px] text-faint">{hint}</p>}
      {rows.length > 0 && (
        <div className="flex flex-col gap-2">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={row.name}
                onChange={(e) => update(i, 'name', e.target.value)}
                placeholder="name"
                className="w-2/5"
              />
              <Input
                value={row.value}
                onChange={(e) => update(i, 'value', e.target.value)}
                placeholder="value, e.g. {{secret.API_KEY}}"
                className="flex-1"
              />
              <button
                type="button"
                className="flex-none text-[12px] text-danger hover:underline"
                onClick={() => onChange(rows.filter((_, x) => x !== i))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The parameter builder — one row per callable argument (name · type · description ·
 * required), compiled to a JSON Schema on submit.
 */
function ParamRows({ rows, onChange }: { rows: ParamRow[]; onChange: (rows: ParamRow[]) => void }) {
  function update(index: number, patch: Partial<ParamRow>) {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.length > 0 && (
        <div className="flex flex-col gap-2">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={row.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="name, e.g. q"
                className="w-1/4 font-mono"
              />
              <Select
                value={row.type}
                onChange={(e) => update(i, { type: e.target.value as ParamType })}
                className="w-28 flex-none"
              >
                {PARAM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
              <Input
                value={row.description}
                onChange={(e) => update(i, { description: e.target.value })}
                placeholder="description (what the model should put here)"
                className="flex-1"
              />
              <label className="flex flex-none items-center gap-1 text-[12px] text-muted" title="Required">
                <input
                  type="checkbox"
                  checked={row.required}
                  onChange={(e) => update(i, { required: e.target.checked })}
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                />
                req
              </label>
              <button
                type="button"
                className="flex-none text-[12px] text-danger hover:underline"
                onClick={() => onChange(rows.filter((_, x) => x !== i))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className="self-start text-[12px] text-accent hover:underline"
        onClick={() => onChange([...rows, { name: '', type: 'string', description: '', required: false }])}
      >
        Add parameter
      </button>
    </div>
  );
}

/** `JSON.parse` that yields `undefined` instead of throwing, for already-validated text. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface ToolVersionFieldsProps {
  form: VersionFormState;
  /** Applies a partial update — the parent owns the state. */
  onChange: (patch: Partial<VersionFormState>) => void;
  /** Which field a failed commit blamed, and what to say about it. */
  error?: { field: VersionFormField; message: string } | null;
}

/**
 * Every field that defines one tool version: what the model reads, what arguments it may
 * send, and who runs the call.
 *
 * Shared by the two dialogs that write a version — the one that creates a tool and the
 * one that commits onto an existing one — because they collect exactly the same thing.
 * When they were separate, only one of them existed, which is why creating a tool left a
 * shell that could not be called.
 *
 * The parent owns the state so it can prefill, reset and submit; this renders it.
 *
 * @param form - Current form state.
 * @param onChange - Receives a partial patch on every edit.
 * @param error - The field a rejected commit blamed, rendered beside that field.
 */
export function ToolVersionFields({ form, onChange, error }: ToolVersionFieldsProps) {
  // The http executor's rarely-used half. Collapsed by default: a failure predicate and
  // a result schema are real features, but showing them to someone building their first
  // tool makes an eight-field form look like a fifteen-field one. Null means the user has
  // not touched the toggle, so the section follows whether the version has anything in it.
  const [advancedOverride, setAdvancedOverride] = useState<boolean | null>(null);
  const advancedOpen = advancedSectionOpen(advancedOverride, form);

  /** Switch to raw-JSON mode, seeding it from the current builder rows. */
  function switchToJson() {
    onChange({
      schemaText: JSON.stringify(rowsToSchema(form.paramRows, form.rejectUnknown), null, 2),
      schemaMode: 'json',
    });
  }

  /**
   * Switch to the builder. Only reachable when {@link builderAvailability} says
   * `'ready'` — the toggle is disabled otherwise, so a click can never look like it did
   * nothing. The guards stay as a safety net.
   */
  function switchToBuilder() {
    const blank = form.schemaText.trim().length === 0;
    const parsed = blank ? {} : safeParse(form.schemaText);
    const rows = blank ? [] : schemaToRows(parsed);
    if (!rows) return;
    onChange({ paramRows: rows, rejectUnknown: schemaRejectsUnknown(parsed), schemaMode: 'builder' });
  }

  // Whether the raw JSON currently in the box could go back to the row builder. Derived,
  // not stored, so it follows every keystroke — the toggle is disabled when it cannot,
  // instead of swallowing the click silently. Memoized on the two fields it actually
  // reads: every other keystroke in this form (description, headers, …) re-renders this
  // component without re-parsing JSON that has not changed.
  const availability = useMemo(
    () => (form.schemaMode === 'json' ? builderAvailability(form.schemaText) : 'ready'),
    [form.schemaMode, form.schemaText],
  );
  const builderBlockedReason =
    availability === 'invalid-json'
      ? 'Fix the JSON to switch back to the row builder.'
      : availability === 'unrepresentable'
        ? 'The row builder can’t show this schema — it uses enum, minimum, a nested object, or additionalProperties. Keep editing it as JSON.'
        : null;

  return (
    <>
      <Field
        label="Description"
        htmlFor="cv-description"
        hint="What the model reads — this is the tool's purpose, sent to the LLM on every call."
      >
        <Textarea
          id="cv-description"
          rows={2}
          value={form.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="Get the current weather for a city."
        />
      </Field>

      <Field label="Changelog" htmlFor="cv-changelog" hint="A note for your team. Never sent to the model.">
        <Textarea
          id="cv-changelog"
          rows={2}
          value={form.changelog}
          onChange={(e) => onChange({ changelog: e.target.value })}
          placeholder="Added support for the units parameter."
        />
      </Field>

      <Field
        label="Parameters"
        hint="The arguments the model fills in when it calls this tool."
        error={error?.field === 'parameters' ? error.message : undefined}
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-faint">
              {form.schemaMode === 'builder' ? 'Add one row per argument.' : 'Raw JSON Schema.'}
            </span>
            <button
              type="button"
              className={
                builderBlockedReason
                  ? 'cursor-not-allowed text-[12px] text-faint'
                  : 'text-[12px] text-accent hover:underline'
              }
              disabled={builderBlockedReason !== null}
              title={builderBlockedReason ?? undefined}
              onClick={form.schemaMode === 'builder' ? switchToJson : switchToBuilder}
            >
              {form.schemaMode === 'builder' ? 'Edit as JSON' : 'Back to builder'}
            </button>
          </div>
          {builderBlockedReason && <p className="text-[12px] text-faint">{builderBlockedReason}</p>}
          {form.schemaMode === 'builder' ? (
            <>
              <ParamRows rows={form.paramRows} onChange={(paramRows) => onChange({ paramRows })} />
              <label className="flex items-center gap-2 text-[12px] text-muted">
                <input
                  type="checkbox"
                  checked={form.rejectUnknown}
                  onChange={(e) => onChange({ rejectUnknown: e.target.checked })}
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                />
                Reject arguments not listed above (<code>additionalProperties: false</code>)
              </label>
            </>
          ) : (
            <Textarea
              id="cv-schema"
              mono
              rows={8}
              value={form.schemaText}
              onChange={(e) => onChange({ schemaText: e.target.value })}
              placeholder={EMPTY_SCHEMA_TEXT}
            />
          )}
        </div>
      </Field>

      <Field label="Executor" htmlFor="cv-executor-type" hint="Who runs this tool when it's called.">
        <Select
          id="cv-executor-type"
          value={form.executorType}
          onChange={(e) => onChange({ executorType: e.target.value as 'client' | 'http' })}
        >
          <option value="client">Client — your own code runs it</option>
          <option value="http">HTTP — AcruxCore calls a URL for you</option>
        </Select>
      </Field>

      {form.executorType === 'client' && (
        <p className="rounded-md border border-line bg-elevated px-3 py-2 text-[12.5px] text-muted">
          Your app receives the call and returns the result. In the SDK, pass the function under
          this tool's name — <code className="font-mono">client_tools=&#123;"name": fn&#125;</code> in
          Python, <code className="font-mono">clientTools</code> in Node.
        </p>
      )}

      {form.executorType === 'http' && (
        <div className="flex flex-col gap-3 rounded-lg border border-line-soft p-3">
          <div className="flex gap-2">
            <Field label="Method" htmlFor="cv-method" className="w-32 flex-none">
              <Select
                id="cv-method"
                value={form.method}
                onChange={(e) => onChange({ method: e.target.value as VersionFormState['method'] })}
              >
                {HTTP_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
            {/* A real, reachable host. The URL is DNS-resolved at commit time and a host
                that does not exist is rejected, so a placeholder like api.example.com sent
                anyone who copied it straight into a rejection on their first tool. */}
            <Field label="URL" htmlFor="cv-url" className="flex-1">
              <Input
                id="cv-url"
                value={form.url}
                onChange={(e) => onChange({ url: e.target.value })}
                placeholder="https://api.open-meteo.com/v1/forecast"
              />
            </Field>
          </div>

          <KeyValueRows
            label="Headers"
            hint="Values may reference a stored secret via {{secret.NAME}} or a model argument via {{arg.NAME}}."
            rows={form.headers}
            onChange={(headers) => onChange({ headers })}
          />
          <KeyValueRows
            label="Query params"
            hint="Values may reference a stored secret via {{secret.NAME}} or a model argument via {{arg.NAME}} (e.g. q = {{arg.q}})."
            rows={form.query}
            onChange={(query) => onChange({ query })}
          />

          <Field
            label="Request transform"
            htmlFor="cv-req-transform"
            hint="Optional JS: a full function transform(input) { … } run server-side before the call. input is the tool arguments; return the request body."
          >
            <Textarea
              id="cv-req-transform"
              mono
              rows={3}
              value={form.requestTransform}
              onChange={(e) => onChange({ requestTransform: e.target.value })}
              placeholder={"function transform(input) {\n  return { ...input, units: input.units ?? 'metric' };\n}"}
            />
          </Field>

          <Field
            label="Response transform"
            htmlFor="cv-res-transform"
            hint="Optional JS: a full function transform(input) { … } run server-side on the raw response. input is { status, headers, body }; return the reshaped result."
          >
            <Textarea
              id="cv-res-transform"
              mono
              rows={3}
              value={form.responseTransform}
              onChange={(e) => onChange({ responseTransform: e.target.value })}
              placeholder={'function transform(input) {\n  return input.body;\n}'}
            />
          </Field>

          <div className="flex flex-col gap-3 border-t border-line-soft pt-3">
            <button
              type="button"
              className="self-start text-[12px] text-accent hover:underline"
              onClick={() => setAdvancedOverride(!advancedOpen)}
            >
              {advancedOpen ? 'Hide' : 'Show'} failure checks
            </button>
            {advancedOpen && (
              <>
                <Field
                  label="Failure predicate"
                  htmlFor="cv-failure-when"
                  hint="Optional JS: decides whether a call failed when the status code can't say so — a 200 carrying {&quot;error&quot;: …}. Same function transform(input) { … } shape; input is the raw { status, headers, body }. Return null for success, or { message } to record a failure."
                >
                  <Textarea
                    id="cv-failure-when"
                    mono
                    rows={3}
                    value={form.failureWhen}
                    onChange={(e) => onChange({ failureWhen: e.target.value })}
                    placeholder={
                      'function transform(input) {\n  return input.body.results?.length ? null : { message: "no match" };\n}'
                    }
                  />
                </Field>

                <Field
                  label="Result schema"
                  htmlFor="cv-result-schema"
                  hint="Optional JSON Schema the result must satisfy, checked after the response transform. Leave empty for no check."
                  error={error?.field === 'resultSchema' ? error.message : undefined}
                >
                  <Textarea
                    id="cv-result-schema"
                    mono
                    rows={4}
                    value={form.resultSchemaText}
                    onChange={(e) => onChange({ resultSchemaText: e.target.value })}
                    placeholder={'{\n  "type": "object",\n  "required": ["lat", "lon"]\n}'}
                  />
                </Field>

                {form.resultSchemaText.trim() !== '' && (
                  <Field
                    label="On mismatch"
                    htmlFor="cv-result-severity"
                    hint="A warning still returns the result and flags the span. An error fails the call."
                  >
                    <Select
                      id="cv-result-severity"
                      // `null` (no source severity, not yet touched) shows as "Warn" — the
                      // same default `emptyVersionForm` used to write in eagerly — without
                      // committing to that value until the user actually picks something.
                      value={form.resultSchemaSeverity ?? 'warn'}
                      onChange={(e) =>
                        onChange({ resultSchemaSeverity: e.target.value as 'warn' | 'error' })
                      }
                    >
                      <option value="warn">Warn — record it and carry on</option>
                      <option value="error">Error — fail the call</option>
                    </Select>
                  </Field>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
