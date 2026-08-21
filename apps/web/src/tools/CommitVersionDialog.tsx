import { useEffect, useState } from 'react';
import type { Executor, HttpHeader, ToolVersionSource } from '@/api';
import { ApiError, useCommitToolVersion, useToolVersion } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, Select, Textarea, useToast } from '@/ui';
import type { ParamRow, ParamType } from './param-schema';
import {
  PARAM_TYPES,
  builderAvailability,
  rowsToSchema,
  schemaRejectsUnknown,
  schemaToRows,
} from './param-schema';

type HttpMethod = NonNullable<Executor['method']>;
const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export interface CommitVersionDialogProps {
  /** The tool this version is committed to. */
  toolId: string;
  /**
   * Version number to prefill the form from (the tool's latest), so "New
   * version" starts from the current config instead of blank. Null/undefined
   * (e.g. the first-ever version) opens the form empty.
   */
  prefillVersion?: number | null;
  /**
   * `source` of the version the tool's `production` alias currently points at, used
   * to warn before editing a tool that a deploy owns. Null/undefined shows no warning.
   */
  liveVersionSource?: ToolVersionSource | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** One editable name/value row (used for both headers and query params). */
interface KeyValueRowsProps {
  label: string;
  hint?: string;
  rows: HttpHeader[];
  onChange: (rows: HttpHeader[]) => void;
}

/**
 * A labeled, repeatable list of name/value inputs — the shared editor for an
 * `http` executor's `headers` and `query` arrays. Not exported: it only makes
 * sense wired to this dialog's own state setters.
 */
function KeyValueRows({ label, hint, rows, onChange }: KeyValueRowsProps) {
  function update(index: number, field: keyof HttpHeader, value: string) {
    onChange(rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }
  function remove(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }
  function add() {
    onChange([...rows, { name: '', value: '' }]);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        <button type="button" className="text-[12px] text-accent hover:underline" onClick={add}>
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
                onClick={() => remove(i)}
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

interface ParamRowsProps {
  rows: ParamRow[];
  onChange: (rows: ParamRow[]) => void;
}

/**
 * The parameter builder — one row per callable argument (name · type ·
 * description · required), compiled to a JSON Schema on submit. The ergonomic
 * front-end for `parametersSchema`; the dialog can drop to raw JSON for
 * schemas this can't express (see {@link schemaToRows}).
 */
function ParamRows({ rows, onChange }: ParamRowsProps) {
  function update(index: number, patch: Partial<ParamRow>) {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function remove(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }
  function add() {
    onChange([...rows, { name: '', type: 'string', description: '', required: false }]);
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
                onClick={() => remove(i)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="self-start text-[12px] text-accent hover:underline" onClick={add}>
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

/** The blank JSON shown when switching an empty builder to raw-JSON mode. */
const EMPTY_SCHEMA_TEXT = '{\n  "type": "object",\n  "properties": {}\n}';

/**
 * The executor editor: commits a new immutable version onto a tool. Collects
 * a description, the callable parameters (edited as a row builder that
 * compiles to JSON Schema, or as raw JSON), and the executor — either
 * `client` (definition-only, the caller's app runs it) or `http` (a
 * declarative call the gateway performs, with optional JS pre/post transforms
 * run server-side in a sandbox). When {@link prefillVersion} is set, the form
 * opens populated from that version's description, schema + executor.
 *
 * `description` and `changelog` are deliberately separate fields: `description` is
 * sent to the model on every call and is what it reads to decide whether to use the
 * tool, while `changelog` is a note for the team that the model never sees. They used
 * to be one field, hinted as "what changed in this version" — which is how a release
 * note ends up being the tool's advertised purpose.
 *
 * When {@link liveVersionSource} is `code`, a banner warns that the next deploy will
 * supersede whatever is committed here.
 *
 * @param toolId - The tool this version is committed to.
 * @param prefillVersion - Version number to prefill from, or null for a blank form.
 * @param liveVersionSource - Source of the version `production` points at, or null.
 * @param open - Whether the dialog is visible.
 * @param onOpenChange - Called to open/close the dialog.
 */
export function CommitVersionDialog({
  toolId,
  prefillVersion,
  liveVersionSource,
  open,
  onOpenChange,
}: CommitVersionDialogProps) {
  const toast = useToast();
  const commit = useCommitToolVersion(toolId);
  // Fetch the version to prefill from — only while the dialog is open.
  const prefill = useToolVersion(toolId, open ? (prefillVersion ?? null) : null);

  const [description, setDescription] = useState('');
  const [changelog, setChangelog] = useState('');
  const [schemaMode, setSchemaMode] = useState<'builder' | 'json'>('builder');
  // The builder's `additionalProperties: false` checkbox. Kept beside the rows
  // rather than inside them: it is one property of the whole object, not of a row.
  const [rejectUnknown, setRejectUnknown] = useState(false);
  const [paramRows, setParamRows] = useState<ParamRow[]>([]);
  const [schemaText, setSchemaText] = useState(EMPTY_SCHEMA_TEXT);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [executorType, setExecutorType] = useState<'client' | 'http'>('client');
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState<HttpMethod>('GET');
  const [headers, setHeaders] = useState<HttpHeader[]>([]);
  const [query, setQuery] = useState<HttpHeader[]>([]);
  const [requestTransform, setRequestTransform] = useState('');
  const [responseTransform, setResponseTransform] = useState('');
  // Guards one-time prefill hydration per open, so a background refetch can't
  // clobber edits the user has since made.
  const [hydrated, setHydrated] = useState(false);

  // Reset the form to blank defaults every time the dialog opens; clear the
  // hydration guard so the prefill effect below can run once.
  useEffect(() => {
    if (!open) {
      setHydrated(false);
      return;
    }
    setDescription('');
    setChangelog('');
    setSchemaMode('builder');
    setParamRows([]);
    setRejectUnknown(false);
    setSchemaText(EMPTY_SCHEMA_TEXT);
    setSchemaError(null);
    setExecutorType('client');
    setUrl('');
    setMethod('GET');
    setHeaders([]);
    setQuery([]);
    setRequestTransform('');
    setResponseTransform('');
  }, [open]);

  // Prefill from the latest version once it loads.
  //
  // `description` IS carried forward: it is what the model reads, so it is config
  // like the schema and the executor. Leaving it blank would mean every commit made
  // here silently dropped the tool's purpose from the model's view. `changelog` is
  // deliberately NOT carried forward — a release note describes one commit, and
  // repeating the previous one would be wrong on every version after the first.
  useEffect(() => {
    if (!open || hydrated) return;
    if (prefillVersion == null) {
      setHydrated(true);
      return;
    }
    if (!prefill.data) return;
    const v = prefill.data;

    setDescription(v.description ?? '');

    const rows = schemaToRows(v.parametersSchema);
    if (rows) {
      setSchemaMode('builder');
      setParamRows(rows);
      setRejectUnknown(schemaRejectsUnknown(v.parametersSchema));
    } else {
      setSchemaMode('json');
      setSchemaText(JSON.stringify(v.parametersSchema, null, 2));
    }

    if (v.executor.type === 'http') {
      setExecutorType('http');
      setUrl(v.executor.url ?? '');
      setMethod(v.executor.method ?? 'GET');
      setHeaders(v.executor.headers ?? []);
      setQuery(v.executor.query ?? []);
      setRequestTransform(v.executor.requestTransform ?? '');
      setResponseTransform(v.executor.responseTransform ?? '');
    } else {
      setExecutorType('client');
    }
    setHydrated(true);
  }, [open, hydrated, prefillVersion, prefill.data]);

  /** Switch to raw-JSON mode, seeding it from the current builder rows. */
  function switchToJson() {
    setSchemaText(JSON.stringify(rowsToSchema(paramRows, rejectUnknown), null, 2));
    setSchemaError(null);
    setSchemaMode('json');
  }

  /**
   * Switch to the builder. Only reachable when {@link builderAvailability} says
   * `'ready'` — the toggle is disabled otherwise, so a click can never look like
   * it did nothing. The guards stay as a safety net.
   */
  function switchToBuilder() {
    const parsed = schemaText.trim().length === 0 ? {} : safeParse(schemaText);
    const rows = schemaText.trim().length === 0 ? [] : schemaToRows(parsed);
    if (!rows) return;
    setParamRows(rows);
    setRejectUnknown(schemaRejectsUnknown(parsed));
    setSchemaError(null);
    setSchemaMode('builder');
  }

  // Whether the raw JSON currently in the box could go back to the row builder.
  // Derived, not stored, so it follows every keystroke — the toggle is disabled
  // when it cannot, instead of swallowing the click silently.
  const availability = schemaMode === 'json' ? builderAvailability(schemaText) : 'ready';
  const builderBlockedReason =
    availability === 'invalid-json'
      ? 'Fix the JSON to switch back to the row builder.'
      : availability === 'unrepresentable'
        ? 'The row builder can’t show this schema — it uses enum, minimum, a nested object, or additionalProperties. Keep editing it as JSON.'
        : null;

  const httpUrlFilled = url.trim().length > 0;
  const canSubmit =
    (schemaMode === 'builder' || schemaText.trim().length > 0) &&
    (executorType === 'client' || httpUrlFilled);

  async function handleSubmit() {
    let parsedSchema: Record<string, unknown>;
    if (schemaMode === 'builder') {
      parsedSchema = rowsToSchema(paramRows, rejectUnknown);
    } else {
      try {
        const parsed: unknown = JSON.parse(schemaText);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('parametersSchema must be a JSON object');
        }
        parsedSchema = parsed as Record<string, unknown>;
      } catch {
        setSchemaError('Parameters must be valid JSON (a JSON object).');
        return;
      }
    }
    setSchemaError(null);

    const executor: Executor =
      executorType === 'client'
        ? { type: 'client' }
        : {
            type: 'http',
            url: url.trim(),
            method,
            headers: headers.filter((h) => h.name.trim() !== ''),
            query: query.filter((h) => h.name.trim() !== ''),
            requestTransform: requestTransform.trim() || undefined,
            responseTransform: responseTransform.trim() || undefined,
          };

    try {
      await commit.mutateAsync({
        description: description.trim() || undefined,
        changelog: changelog.trim() || undefined,
        source: 'dashboard',
        parametersSchema: parsedSchema,
        executor,
      });
      toast.success('Version committed');
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not commit version');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New version"
      description="Versions are immutable — commit a new one to change parameters or the executor."
      className="max-w-2xl"
    >
      <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto pr-1">
        {liveVersionSource === 'code' && (
          <div
            className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-[13px] text-ink"
            data-testid="code-owned-warning"
          >
            This tool is defined in code with <code className="font-mono">@acrux.tool</code>. The next
            deploy will commit a version from the code definition and move{' '}
            <code className="font-mono">production</code> to it. Your change stays in the version
            history and can be promoted back, but it stops being live.
          </div>
        )}

        <Field
          label="Description"
          htmlFor="cv-description"
          hint="What the model reads — this is the tool's purpose, sent to the LLM on every call."
        >
          <Textarea
            id="cv-description"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Get the current weather for a city."
          />
        </Field>

        <Field
          label="Changelog"
          htmlFor="cv-changelog"
          hint="A note for your team. Never sent to the model."
        >
          <Textarea
            id="cv-changelog"
            rows={2}
            value={changelog}
            onChange={(e) => setChangelog(e.target.value)}
            placeholder="Added support for the units parameter."
          />
        </Field>

        <Field
          label="Parameters"
          hint="The arguments the model fills in when it calls this tool."
          error={schemaError ?? undefined}
        >
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-faint">
                {schemaMode === 'builder' ? 'Add one row per argument.' : 'Raw JSON Schema.'}
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
                onClick={schemaMode === 'builder' ? switchToJson : switchToBuilder}
              >
                {schemaMode === 'builder' ? 'Edit as JSON' : 'Back to builder'}
              </button>
            </div>
            {builderBlockedReason && <p className="text-[12px] text-faint">{builderBlockedReason}</p>}
            {schemaMode === 'builder' ? (
              <>
                <ParamRows rows={paramRows} onChange={setParamRows} />
                <label className="flex items-center gap-2 text-[12px] text-muted">
                  <input
                    type="checkbox"
                    checked={rejectUnknown}
                    onChange={(e) => setRejectUnknown(e.target.checked)}
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
                value={schemaText}
                onChange={(e) => {
                  setSchemaText(e.target.value);
                  if (schemaError) setSchemaError(null);
                }}
                placeholder={EMPTY_SCHEMA_TEXT}
              />
            )}
          </div>
        </Field>

        <Field label="Executor" htmlFor="cv-executor-type" hint="Who runs this tool when it's called.">
          <Select
            id="cv-executor-type"
            value={executorType}
            onChange={(e) => setExecutorType(e.target.value as 'client' | 'http')}
          >
            <option value="client">Client — the caller's app runs it</option>
            <option value="http">HTTP — the gateway calls a URL</option>
          </Select>
        </Field>

        {executorType === 'http' && (
          <div className="flex flex-col gap-3 rounded-lg border border-line-soft p-3">
            <div className="flex gap-2">
              <Field label="Method" htmlFor="cv-method" className="w-32 flex-none">
                <Select
                  id="cv-method"
                  value={method}
                  onChange={(e) => setMethod(e.target.value as HttpMethod)}
                >
                  {HTTP_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="URL" htmlFor="cv-url" className="flex-1">
                <Input
                  id="cv-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://api.example.com/weather"
                />
              </Field>
            </div>

            <KeyValueRows
              label="Headers"
              hint="Values may reference a stored secret via {{secret.NAME}} or a model argument via {{arg.NAME}}."
              rows={headers}
              onChange={setHeaders}
            />
            <KeyValueRows
              label="Query params"
              hint="Values may reference a stored secret via {{secret.NAME}} or a model argument via {{arg.NAME}} (e.g. q = {{arg.q}})."
              rows={query}
              onChange={setQuery}
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
                value={requestTransform}
                onChange={(e) => setRequestTransform(e.target.value)}
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
                value={responseTransform}
                onChange={(e) => setResponseTransform(e.target.value)}
                placeholder={"function transform(input) {\n  return input.body;\n}"}
              />
            </Field>
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={commit.isPending || !canSubmit} onClick={handleSubmit}>
          {commit.isPending ? 'Committing…' : 'Commit version'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
