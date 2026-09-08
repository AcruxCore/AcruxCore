import { useEffect, useState } from 'react';
import { ApiError, useAddDatasetExample, useAddExamplesFromFeedback, useFeedbackFeed } from '@/api';
import { Button, Dialog, DialogFooter, Field, IconButton, Input, Spinner, Tabs, Textarea, TrashIcon, useToast } from '@/ui';
import { feedbackByline, FilterBar, filterStateToBody, type FilterState } from '@/traces';
import { timeAgo } from '@/lib/format';

export interface AddExampleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dataset the example is added to. */
  datasetId: string;
  /**
   * Variable names already used by this dataset's examples, if any. The form
   * starts pre-seeded with them so every example in a dataset ends up with the
   * same shape — which is what a run against one prompt needs.
   */
  knownVariables?: string[];
}

/** One editable `input` entry. `id` keeps React keys stable while rows are renamed. */
interface VariableRow {
  id: number;
  key: string;
  value: string;
}

let nextRowId = 0;
function makeRow(key = ''): VariableRow {
  return { id: nextRowId++, key, value: '' };
}

/**
 * Turns the variable rows into the `input` object the API expects. Rows with a
 * blank key are dropped, so a half-typed extra row never reaches the request.
 */
function rowsToInput(rows: VariableRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) out[key] = row.value;
  }
  return out;
}

/** How many feedback rows the picker shows at once. */
const FEEDBACK_PAGE_SIZE = 25;

/**
 * The "From feedback" tab: pick real feedback rows and pull them in as examples.
 *
 * This is the path that carries real signal. Each selected row brings the
 * variables actually captured on its trace as `input`, the reviewer's comment as
 * the judge criteria, and the reconstructed session history — none of which a
 * person can retype accurately from a screenshot.
 *
 * A row already in this dataset is not rejected here but reported back in
 * `skipped`, because whether a given row is already filed is exactly what the
 * person selecting it cannot see.
 */
function FromFeedbackPanel({
  datasetId,
  onDone,
}: {
  datasetId: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Plain state, not the URL: a dialog's filters are not something to link to,
  // and writing them to the address bar would also refilter the page behind it.
  const [filters, setFilters] = useState<FilterState>({});
  const feed = useFeedbackFeed({ ...filters, page, limit: FEEDBACK_PAGE_SIZE });
  const add = useAddExamplesFromFeedback(datasetId);

  const rows = feed.data?.data ?? [];
  const total = feed.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / FEEDBACK_PAGE_SIZE));
  const hasFilters = Object.keys(filters).length > 0;

  function changeFilters(next: FilterState) {
    setFilters(next);
    setPage(1);
    // A selection made under the old filters is no longer visible, and adding
    // rows the person can't see is the opposite of what filtering is for.
    setSelected(new Set());
  }

  function toggle(id: string, checked: boolean) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /** Reports one result the same way whether it came from ids or from criteria. */
  function report(result: Awaited<ReturnType<typeof add.mutateAsync>>) {
    if (result.added === 0) {
      // Not an error: every row was already filed, or none had captured
      // variables. Say which, since the counts alone look like a bug.
      toast.error(result.skipped[0]?.reason ?? 'Nothing was added.');
      return;
    }
    const note =
      result.skipped.length > 0
        ? ` (${result.skipped.length} skipped: ${result.skipped[0].reason})`
        : '';
    toast.success(`Added ${result.added} example${result.added === 1 ? '' : 's'}${note}`);
    onDone();
  }

  async function handleAdd() {
    if (selected.size === 0) {
      setError('Select at least one feedback row.');
      return;
    }
    setError(null);
    try {
      report(await add.mutateAsync({ feedback_ids: [...selected] }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add those examples.');
    }
  }

  /**
   * Adds every row the current filters select, not just the page on screen.
   *
   * Sends the criteria rather than the ids, so the server resolves them — which
   * is the only way to reach rows on pages the person never opened. The API caps
   * one request at 100 rows and reports how many matched, so a wider filter says
   * what it left behind instead of dropping it silently.
   */
  async function handleAddAllMatching() {
    setError(null);
    try {
      const result = await add.mutateAsync({ filter: filterStateToBody(filters) });
      if (result.matched !== undefined && result.matched > result.added + result.skipped.length) {
        toast.error(
          `${result.matched} rows matched but only ${result.added + result.skipped.length} were processed. Narrow the filters and add the rest.`,
        );
      }
      report(result);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add those examples.');
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Filtering is the whole point here: nobody scrolls 500 rows to find the
          twenty that matter. A saved view applies in one click. */}
      <FilterBar value={filters} onChange={changeFilters} surface="feedback" />
      {feed.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : feed.isError ? (
        <p className="py-6 text-center text-[13px] text-muted">Couldn’t load feedback. Try again.</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-muted">
          {hasFilters
            ? 'No feedback matches these filters. Clear one, or widen the date range.'
            : 'No feedback yet. Feedback posted on a trace or span shows up here.'}
        </p>
      ) : (
        <>
          <ul className="flex max-h-[320px] flex-col gap-1.5 overflow-y-auto" data-testid="from-feedback-list">
            {rows.map((f) => (
              <li key={f.id} className="flex items-start gap-2 border-b border-line-soft pb-1.5 text-[13px] last:border-0">
                <input
                  type="checkbox"
                  aria-label={`Select feedback ${f.id.slice(0, 8)}`}
                  checked={selected.has(f.id)}
                  onChange={(e) => toggle(f.id, e.target.checked)}
                  className="mt-1 h-4 w-4 accent-varhi"
                  data-testid="from-feedback-checkbox"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    {f.rating !== null && (
                      <span className={`font-mono ${f.rating < 0 ? 'text-danger' : 'text-ok'}`}>
                        {f.rating > 0 ? `▲ ${f.rating}` : f.rating < 0 ? '▼' : '0'}
                      </span>
                    )}
                    {f.label && (
                      <span className="rounded border border-line-soft px-1.5 py-0.5 text-[11px] text-muted">
                        {f.label}
                      </span>
                    )}
                    <span className="truncate text-ink">{f.comment ?? <span className="text-faint">No comment</span>}</span>
                  </div>
                  <span className="text-[11px] text-faint">
                    {feedbackByline(f.source, f.author)} · {timeAgo(f.createdAt)} · trace {f.traceId.slice(0, 8)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-3 text-[12px] text-muted">
            {totalPages > 1 && (
              <>
                <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <span>
                  Page {page} of {totalPages}
                </span>
                <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </>
            )}
            <span className="ml-auto">
              {total} row{total === 1 ? '' : 's'} match{total === 1 ? 'es' : ''}
            </span>
          </div>
        </>
      )}
      {error && <p className="text-[12px] text-danger">{error}</p>}
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        {hasFilters && total > 0 && (
          <Button
            variant="default"
            disabled={add.isPending}
            onClick={handleAddAllMatching}
            title="Adds every row these filters select, including pages you have not opened."
            data-testid="from-feedback-add-matching"
          >
            {add.isPending ? 'Adding…' : `Add all ${total} matching`}
          </Button>
        )}
        <Button
          variant="primary"
          disabled={add.isPending || selected.size === 0}
          onClick={handleAdd}
          data-testid="from-feedback-submit"
        >
          {add.isPending ? 'Adding…' : `Add ${selected.size || ''} selected`.trim()}
        </Button>
      </DialogFooter>
    </div>
  );
}

/**
 * Adds examples to a dataset, either by hand or by pulling in real feedback.
 *
 * Two tabs, because the two routes in are genuinely different work. **From
 * feedback** is the one that carries signal — it brings the captured variables,
 * the reviewer's comment as criteria, and the session history along with the
 * row. **Manual** exists for the team that has no traffic yet, and for the
 * hand-written edge case a real trace never produced.
 *
 * Within the manual tab there are two input modes, because `input` is a
 * free-form variable bag: named fields cover the ordinary case where every
 * variable is a string rendered into a template, and a raw JSON mode covers
 * values that are not strings — numbers, lists, nested objects — which the
 * field editor cannot express.
 */
export function AddExampleDialog({ open, onOpenChange, datasetId, knownVariables }: AddExampleDialogProps) {
  const toast = useToast();
  const add = useAddDatasetExample(datasetId);
  const [rows, setRows] = useState<VariableRow[]>([makeRow()]);
  const [jsonMode, setJsonMode] = useState(false);
  const [json, setJson] = useState('{}');
  const [criteria, setCriteria] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'feedback' | 'manual'>('feedback');

  // Reset to a fresh form every time the dialog is (re)opened, seeded with the
  // dataset's existing variable names so examples stay consistent with each other.
  useEffect(() => {
    if (!open) return;
    const seeds = knownVariables?.length ? knownVariables : [''];
    setRows(seeds.map((k) => makeRow(k)));
    setJsonMode(false);
    setJson('{}');
    setCriteria('');
    setError(null);
    setTab('feedback');
  }, [open, knownVariables]);

  /** Switching to JSON carries the typed fields across, so nothing is silently lost. */
  function toggleJsonMode() {
    if (!jsonMode) setJson(JSON.stringify(rowsToInput(rows), null, 2));
    setJsonMode(!jsonMode);
    setError(null);
  }

  async function handleAdd() {
    let input: Record<string, unknown>;
    if (jsonMode) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        setError('That is not valid JSON.');
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError('Input must be a JSON object of variable names to values.');
        return;
      }
      input = parsed as Record<string, unknown>;
    } else {
      input = rowsToInput(rows);
    }

    if (Object.keys(input).length === 0) {
      setError('Add at least one variable.');
      return;
    }

    setError(null);
    try {
      await add.mutateAsync({ input, criteria: criteria.trim() || undefined });
      toast.success('Example added');
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add the example.');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add example"
      description="Pull rows in from real feedback, or write one by hand."
    >
      <Tabs
        items={[
          { value: 'feedback', label: 'From feedback' },
          { value: 'manual', label: 'Manual' },
        ]}
        value={tab}
        onChange={(value) => setTab(value as 'feedback' | 'manual')}
      />

      {tab === 'feedback' ? (
        <FromFeedbackPanel datasetId={datasetId} onDone={() => onOpenChange(false)} />
      ) : (
        <>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-ink">Input variables</span>
            <Button variant="ghost" size="sm" onClick={toggleJsonMode} data-testid="add-example-json-toggle">
              {jsonMode ? 'Edit as fields' : 'Edit as JSON'}
            </Button>
          </div>

          {jsonMode ? (
            <Textarea
              mono
              rows={6}
              value={json}
              onChange={(e) => setJson(e.target.value)}
              aria-label="Input variables as JSON"
              data-testid="add-example-json"
            />
          ) : (
            <div className="flex flex-col gap-2">
              {rows.map((row, i) => (
                <div key={row.id} className="flex items-center gap-2">
                  <Input
                    value={row.key}
                    onChange={(e) =>
                      setRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)))
                    }
                    placeholder="variable"
                    aria-label={`Variable ${i + 1} name`}
                    className="max-w-[200px] font-mono"
                    data-testid="add-example-var-key"
                    // Without this the dialog's first focusable element is the
                    // JSON-mode toggle, so opening the form lands focus on the
                    // escape hatch rather than on the field to fill in.
                    autoFocus={i === 0}
                  />
                  <Input
                    value={row.value}
                    onChange={(e) =>
                      setRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))
                    }
                    placeholder="value"
                    aria-label={`Variable ${i + 1} value`}
                    data-testid="add-example-var-value"
                  />
                  <IconButton
                    tone="danger"
                    aria-label={`Remove variable ${i + 1}`}
                    disabled={rows.length === 1}
                    onClick={() => setRows((cur) => cur.filter((r) => r.id !== row.id))}
                  >
                    <TrashIcon />
                  </IconButton>
                </div>
              ))}
              <div>
                <Button variant="ghost" size="sm" onClick={() => setRows((cur) => [...cur, makeRow()])}>
                  Add variable
                </Button>
              </div>
            </div>
          )}
          {error && <p className="text-[12px] text-danger">{error}</p>}
        </div>

        <Field
          label="Criteria"
          htmlFor="add-example-criteria"
          hint="Optional. What the judge should check for on this example."
        >
          <Textarea
            id="add-example-criteria"
            rows={3}
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            placeholder="Names the policy and quotes the refund window."
            data-testid="add-example-criteria"
          />
        </Field>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={add.isPending} onClick={handleAdd} data-testid="add-example-submit">
          {add.isPending ? 'Adding…' : 'Add example'}
        </Button>
      </DialogFooter>
        </>
      )}
    </Dialog>
  );
}
