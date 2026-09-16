import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, useDataset, useDeleteDataset, useRemoveDatasetExample, useUpdateDatasetExample } from '@/api';
import { Button, Empty, IconButton, InfoTip, PageSpinner, PencilIcon, Textarea, TrashIcon, useToast } from '@/ui';
import { cn } from '@/lib/cn';
import { dateTime, timeAgo } from '@/lib/format';
import type { DatasetExample } from '@/api/types';
import { AddExampleDialog } from './AddExampleDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { HistoryDisclosure } from './HistoryDisclosure';
import { useAuth } from '@/auth/AuthContext';
import { OptimizeDatasetDialog } from './OptimizeDatasetDialog';

/** Renders a variable value the way the cell shows it — objects as JSON, strings raw. */
function valueText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** One line of the Input cell: a variable, or the prompt's own last user message. */
interface PreviewLine {
  key: string;
  /** The variable name, or null for the message line, which has no name. */
  label: string | null;
  text: string;
  /** True for the version's message — styled apart, because it is not per-example data. */
  fromPrompt: boolean;
}

/** Hover text on the message line, so the row explains itself without the header tooltip. */
const FROM_PROMPT_HINT =
  'From the prompt version. This example declares no variables, so this message is the same on every example built from that version.';

/**
 * Renders an example's `input` variable bag as compact `key: value` pairs, or —
 * when there are no variables — the prompt version's own last user message.
 *
 * One line per entry, clipped, because a variable can hold a whole document — a
 * retrieved passage or a house policy pasted in as context — and rendering those
 * in full made a single row taller than the rest of the table put together.
 *
 * The two things shown are not equivalent, which is why they do not look alike.
 * Variables are per-example: they are what an experiment re-renders a candidate
 * prompt against. A literal message belongs to the prompt version, so it is
 * identical on every row built from it and an experiment does not vary it. It is
 * shown in muted, quoted, non-mono text purely so a reader can see what was asked
 * instead of a bare dash — never as though it were this row's input. It is also
 * shown raw: no `{{ placeholder }}` in it is filled in, since the values that
 * would fill them are exactly what this example does not have.
 */
function InputPreview({
  input,
  sourcePrompt,
}: {
  input: Record<string, unknown>;
  sourcePrompt: DatasetExample['sourcePrompt'];
}) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const entries = Object.entries(input);
  const lines: PreviewLine[] =
    entries.length > 0
      ? entries.map(([k, v]) => ({ key: k, label: k, text: valueText(v), fromPrompt: false }))
      : sourcePrompt?.lastUserMessage
        ? [{ key: '\u0000prompt', label: null, text: sourcePrompt.lastUserMessage, fromPrompt: true }]
        : [];

  // Whether a line is cut off is measured, not guessed from its length: how much
  // fits depends on the column's width, which depends on the other columns and the
  // window. A character threshold left short-but-clipped values with no way to read
  // the rest of them.
  const measure = useCallback(() => {
    const el = listRef.current;
    // Nothing clips while expanded, so hold the collapsed measurement instead of
    // measuring again and losing the toggle the reader just used.
    if (!el || expanded) return;
    setClipped(Array.from(el.children).some((c) => c.scrollWidth > c.clientWidth + 1));
  }, [expanded]);

  // Keyed on each line's length so a re-render with different data re-measures,
  // without depending on the `input` object's identity.
  const shape = lines.map((l) => `${l.key}:${l.text.length}`).join('|');
  useLayoutEffect(measure, [measure, shape]);

  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  if (lines.length === 0) return <span className="text-faint">—</span>;

  return (
    <div className="flex max-w-[260px] flex-col items-start gap-0.5">
      <div ref={listRef} className="w-full">
        {lines.map((line) => (
          <div
            key={line.key}
            title={line.fromPrompt ? FROM_PROMPT_HINT : undefined}
            data-testid={line.fromPrompt ? 'example-input-from-prompt' : undefined}
            className={cn(
              'text-[12px]',
              line.fromPrompt ? 'text-muted' : 'font-mono',
              !expanded && 'truncate',
            )}
          >
            {line.label !== null && (
              <>
                <span className="text-faint">{line.label}:</span>{' '}
              </>
            )}
            <span
              className={cn(
                !line.fromPrompt && 'text-ink',
                expanded && 'whitespace-pre-wrap break-words',
              )}
            >
              {line.fromPrompt ? `\u201c${line.text}\u201d` : line.text}
            </span>
          </div>
        ))}
      </div>
      {clipped && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-0.5 text-[11px] text-muted underline decoration-dotted hover:text-ink"
        >
          {expanded ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

/**
 * The criteria cell: read-only text until clicked, a textarea once editing.
 *
 * Criteria is the one field on an example that is meant to be rewritten. A row
 * built from feedback inherits the raw complaint, and a complaint reused as a
 * rubric grades correct answers badly, so this is routine curation rather than
 * a rare correction — which is why it edits in place instead of behind a dialog.
 */
function CriteriaCell({ datasetId, example }: { datasetId: string; example: DatasetExample }) {
  const toast = useToast();
  const update = useUpdateDatasetExample(datasetId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(example.criteria ?? '');

  function startEditing() {
    setDraft(example.criteria ?? '');
    setEditing(true);
  }

  async function save() {
    const trimmed = draft.trim();
    // Unchanged is not worth a request, and an empty box means "no rubric",
    // which the API expresses as an explicit null rather than an empty string.
    if (trimmed === (example.criteria ?? '')) {
      setEditing(false);
      return;
    }
    try {
      await update.mutateAsync({ exampleId: example.id, criteria: trimmed || null });
      setEditing(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save the criteria.');
    }
  }

  const { canWrite } = useAuth();

  if (editing) {
    return (
      <div className="flex flex-col gap-2">
        <Textarea
          rows={4}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What the judge should check for on this example."
          aria-label="Criteria"
          data-testid="criteria-input"
        />
        <div className="flex gap-2">
          <Button size="sm" variant="primary" disabled={update.isPending} onClick={save} data-testid="criteria-save">
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2">
      <span className="text-ink">{example.criteria ?? <span className="text-faint">No criteria</span>}</span>
      {canWrite && (
        <IconButton
          onClick={startEditing}
          aria-label={example.criteria ? 'Edit criteria' : 'Add criteria'}
          className="shrink-0"
          data-testid="criteria-edit"
        >
          <PencilIcon />
        </IconButton>
      )}
    </div>
  );
}

/** One row of the examples table. */
function ExampleRow({
  datasetId,
  example,
  onRemove,
}: {
  datasetId: string;
  example: DatasetExample;
  onRemove: (example: DatasetExample) => void;
}) {
  const { canWrite } = useAuth();

  return (
    <tr className="border-b border-line-soft bg-surface align-top last:border-b-0 hover:bg-elevated">
      <td className="px-4 py-2.5">
        <InputPreview input={example.input} sourcePrompt={example.sourcePrompt} />
      </td>
      <td className="px-4 py-2.5">
        <CriteriaCell datasetId={datasetId} example={example} />
      </td>
      <td className="px-4 py-2.5">
        <HistoryDisclosure history={example.history} />
      </td>
      <td className="px-4 py-2.5">
        {example.sourcePrompt ? (
          <Link
            to={`/prompts/${example.sourcePrompt.promptId}`}
            className="text-[12px] text-varhi hover:underline"
            data-testid="example-source-prompt"
          >
            {example.sourcePrompt.name} v{example.sourcePrompt.versionNumber}
          </Link>
        ) : (
          <span className="text-faint" title="Added by hand, or its prompt version has since been deleted">
            —
          </span>
        )}
      </td>
      <td className="px-4 py-2.5">
        {example.sourceTraceId ? (
          <Link
            to={`/traces/${example.sourceTraceId}`}
            className="font-mono text-[12px] text-varhi hover:underline"
          >
            {example.sourceTraceId.slice(0, 8)}
          </Link>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      {canWrite && (
        <td className="px-4 py-2.5 text-right">
          <IconButton
            tone="danger"
            aria-label="Remove this example"
            onClick={() => onRemove(example)}
            data-testid="example-remove"
          >
            <TrashIcon />
          </IconButton>
        </td>
      )}
    </tr>
  );
}

/**
 * The `/evaluations/datasets/:id` screen: the dataset's examples (input
 * variables, judge criteria, the prompt version each row was captured from, and
 * a link back to its source trace), plus the entry points into configuring a
 * run and into curating the set — adding rows from feedback, rewriting a
 * rubric, dropping a row, or deleting the dataset outright.
 */
export function DatasetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, isLoading, isError } = useDataset(id ?? null);
  const removeExample = useRemoveDatasetExample(id ?? '');
  const deleteDataset = useDeleteDataset(id ?? '');
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [addExampleOpen, setAddExampleOpen] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<DatasetExample | null>(null);
  const [confirmDeleteDataset, setConfirmDeleteDataset] = useState(false);
  const { canWrite } = useAuth();

  if (isLoading) return <PageSpinner />;
  if (isError || !data) {
    return <Empty title="Dataset not found" description="This dataset does not exist or is not in your team." />;
  }

  async function handleRemoveExample() {
    if (!pendingRemoval) return;
    try {
      await removeExample.mutateAsync(pendingRemoval.id);
      setPendingRemoval(null);
      toast.success('Example removed');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not remove the example.');
    }
  }

  async function handleDeleteDataset() {
    try {
      await deleteDataset.mutateAsync();
      toast.success('Dataset deleted');
      // The dataset is gone, so staying here would render the "not found"
      // empty state. `useDeleteDataset` leaves this page's detail query
      // untouched precisely so nothing refetches the deleted id on the way out.
      navigate('/evaluations');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not delete the dataset.');
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to="/evaluations" className="text-[12px] text-muted hover:text-ink">
        ← Datasets
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">{data.name}</h1>
          {data.overallFeedback && <p className="mt-1 max-w-xl text-[13px] text-muted">{data.overallFeedback}</p>}
          <div className="mt-2 flex flex-wrap gap-4 text-[13px] text-muted">
            <span>
              {data.exampleCount} example{data.exampleCount === 1 ? '' : 's'}
            </span>
            <span title={dateTime(data.createdAt)}>{timeAgo(data.createdAt)}</span>
          </div>
        </div>
        {/* Every action here is a write the API gates at owner/admin/editor, and
            "Run experiment" leads to a page whose only purpose is to start one. A
            viewer reads the dataset instead of collecting 403s. */}
        {canWrite && (
          <div className="flex gap-2">
            <Button variant="danger" onClick={() => setConfirmDeleteDataset(true)} data-testid="delete-dataset">
              Delete
            </Button>
            <Button variant="ghost" onClick={() => setAddExampleOpen(true)} data-testid="add-example">
              Add example
            </Button>
            <Button variant="ghost" onClick={() => setOptimizeOpen(true)} data-testid="optimize-prompt">
              Optimize a prompt
            </Button>
            <Button variant="primary" onClick={() => navigate(`/evaluations/datasets/${data.id}/run`)}>
              Run experiment
            </Button>
          </div>
        )}
      </header>

      {data.examples.length === 0 ? (
        <Empty
          title="No examples yet"
          description="Add one by hand, pull rows in from feedback, or select feedback rows on the Feedback page to build a dataset from real traffic."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {/* A plain line, not only the header tooltip: the first thing a reader
              needs is what a ROW is, and that should not require a hover. The tip
              on the Input header carries the detail this one line cannot. */}
          <p className="text-[12.5px] text-muted">
            One row is one example: the input a prompt is rendered with, and the criteria a judge
            scores the answer against.
          </p>
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[820px] border-collapse text-left text-[13px]">
              <thead>
                <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.06em] text-faint">
                  <th className="px-4 py-2.5 font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      Input
                      <InfoTip heading="What varies per example" label="What the Input column shows">
                        An example's input is the{' '}
                        <code className="whitespace-nowrap font-mono">{'{{ placeholders }}'}</code> the
                        prompt was rendered with — what a candidate prompt gets re-rendered against
                        when you run an experiment. A prompt with no placeholders has none to record,
                        so the cell falls back to the prompt version's own last message, in grey. That
                        one is the same on every example from that version, and an experiment does not
                        vary it — the template does.
                      </InfoTip>
                    </span>
                  </th>
                  <th className="px-4 py-2.5 font-medium">Criteria</th>
                  <th className="px-4 py-2.5 font-medium">History</th>
                  <th className="px-4 py-2.5 font-medium">Prompt</th>
                  <th className="px-4 py-2.5 font-medium">Source trace</th>
                  {canWrite && (
                    <th className="w-10 px-4 py-2.5 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {data.examples.map((example) => (
                  <ExampleRow
                    key={example.id}
                    datasetId={data.id}
                    example={example}
                    onRemove={setPendingRemoval}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <AddExampleDialog
        open={addExampleOpen}
        onOpenChange={setAddExampleOpen}
        datasetId={data.id}
        // Seed the form with the variable names this dataset already uses, so
        // every example keeps the shape the target prompt renders against.
        knownVariables={data.examples.length > 0 ? Object.keys(data.examples[0].input) : undefined}
      />
      <OptimizeDatasetDialog open={optimizeOpen} onOpenChange={setOptimizeOpen} datasetId={data.id} />

      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => !open && setPendingRemoval(null)}
        title="Remove this example?"
        description="It leaves this dataset for good. Runs that already graded it keep their results — they read the copy frozen into the run, not this row."
        confirmLabel="Remove example"
        pending={removeExample.isPending}
        onConfirm={handleRemoveExample}
      />
      <ConfirmDialog
        open={confirmDeleteDataset}
        onOpenChange={setConfirmDeleteDataset}
        title={`Delete “${data.name}”?`}
        description={`This dataset and its ${data.exampleCount} example${data.exampleCount === 1 ? '' : 's'} stop appearing anywhere. Past experiment runs against it keep their reports.`}
        confirmLabel="Delete dataset"
        pending={deleteDataset.isPending}
        onConfirm={handleDeleteDataset}
      />
    </div>
  );
}
