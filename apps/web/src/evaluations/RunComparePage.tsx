import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Empty, MonoBlock, PageSpinner, Select } from '@/ui';
import { formatPayload } from '@/traces';
import { cn } from '@/lib/cn';
import { useRun, useRunCompare, useRunReport, useRuns } from '@/api';
import type { RunCompareChange, RunCompareExample, RunCompareSide, RunGridCell } from '@/api/types';
import { compareErrorText, defaultComparePair, filterExamples, parseCompareFilter, targetRunProblem } from './compare.helpers';
import type { CompareFilter } from './compare.helpers';

/** Label and colour for each change kind; the text always carries the meaning, never colour alone. */
const CHANGE_META: Record<RunCompareChange, { label: string; tone: string }> = {
  improved: { label: 'Improved', tone: 'text-ok' },
  regressed: { label: 'Regressed', tone: 'text-danger' },
  unchanged: { label: 'Unchanged', tone: 'text-muted' },
  unscored: { label: 'Unscored', tone: 'text-faint' },
  missing: { label: 'Missing', tone: 'text-faint' },
};

const CHANGE_ORDER: RunCompareChange[] = ['improved', 'regressed', 'unchanged', 'unscored', 'missing'];

/** A short one-line preview of an example's input, for the collapsed row. */
function inputPreview(input: Record<string, unknown>): string {
  const text = Object.values(input)
    .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
    .join(' · ');
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/** `v2 · gpt-4o-mini` for a grid cell. */
function cellLabel(cell: { variantLabel: string; model: string }): string {
  return `${cell.variantLabel} · ${cell.model}`;
}

/** One side's verdict in a table cell: pass/fail word plus score. */
function Verdict({ side }: { side: RunCompareSide | null }) {
  if (!side) return <span className="text-faint">No result</span>;
  if (side.passed === null) return <span className="text-faint">Unscored</span>;
  return (
    <span className={side.passed ? 'text-ok' : 'text-danger'}>
      {side.passed ? 'Pass' : 'Fail'}
      <span className="ml-1.5 font-mono text-[12px] text-muted">{side.score ?? '—'}</span>
    </span>
  );
}

/** The expanded half of a row: one cell's output, judge reason and trace link. */
function SideDetail({ title, side }: { title: string; side: RunCompareSide | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="text-[11px] uppercase tracking-[0.06em] text-faint">{title}</div>
      {!side ? (
        <p className="text-[13px] text-faint">This cell has no result for this example.</p>
      ) : (
        <>
          {side.errorMessage != null ? (
            <p className="text-[13px] text-danger">{side.errorMessage || 'The cell failed; no reason was recorded.'}</p>
          ) : (
            <MonoBlock label="Output" value={formatPayload(side.output)} />
          )}
          {side.reason && <p className="text-[13px] text-ink">{side.reason}</p>}
          {side.traceId && (
            <Link to={`/traces/${side.traceId}`} className="text-[12px] text-varhi hover:underline">
              View trace →
            </Link>
          )}
        </>
      )}
    </div>
  );
}

/** One example: a summary row that expands to both outputs side by side. */
function CompareRow({ example, baseTitle, targetTitle }: { example: RunCompareExample; baseTitle: string; targetTitle: string }) {
  const [open, setOpen] = useState(false);
  const meta = CHANGE_META[example.change];
  return (
    <>
      <tr
        className="cursor-pointer border-b border-line-soft bg-surface hover:bg-elevated"
        onClick={() => setOpen((o) => !o)}
        data-testid="compare-row"
        data-change={example.change}
      >
        <td className="px-3 py-2.5 text-faint">{open ? '▾' : '▸'}</td>
        <td className="truncate px-3 py-2.5 text-ink" title={inputPreview(example.input)}>
          {inputPreview(example.input)}
        </td>
        <td className="whitespace-nowrap px-3 py-2.5">
          <Verdict side={example.base} />
        </td>
        <td className="whitespace-nowrap px-3 py-2.5">
          <Verdict side={example.target} />
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono">
          {example.scoreDelta === null ? '—' : example.scoreDelta > 0 ? `+${example.scoreDelta}` : example.scoreDelta}
        </td>
        <td className={cn('whitespace-nowrap px-3 py-2.5 font-medium', meta.tone)}>{meta.label}</td>
      </tr>
      {open && (
        <tr className="border-b border-line-soft bg-elevated">
          <td colSpan={6} className="px-4 py-4">
            <MonoBlock label="Input" value={formatPayload(example.input)} />
            {example.criteria && <p className="mt-2 text-[12px] text-muted">Criteria: {example.criteria}</p>}
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <SideDetail title={`Base — ${baseTitle}`} side={example.base} />
              <SideDetail title={`Target — ${targetTitle}`} side={example.target} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** A cell picker over one run's grid. */
function CellSelect({ cells, value, onChange, label }: { cells: RunGridCell[]; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-56" aria-label={label} data-testid={`compare-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      {cells.map((c) => (
        <option key={c.cellKey} value={c.cellKey}>
          {cellLabel(c)}
        </option>
      ))}
    </Select>
  );
}

/**
 * The `/evaluations/runs/:id/compare` screen: two grid cells side by side, one row per
 * dataset example. A cell's average can stay flat while it fixes some examples and
 * breaks others, so the counters above the table — which double as filters — are the
 * point of the page, and it opens on "Changed" (improved or regressed).
 *
 * The base cell is in this run. The target is in this run or in another run over the
 * same dataset. Everything lives in the URL (`base`, `target`, `target_run`, `show`) so
 * a comparison can be shared as a link.
 */
export function RunComparePage() {
  const { id } = useParams<{ id: string }>();
  const [sp, setSp] = useSearchParams();
  const report = useRunReport(id ?? null);
  const baseRun = useRun(id ?? null);
  const targetRunId = sp.get('target_run') ?? id ?? null;
  const targetRun = useRun(targetRunId);
  const datasetId = baseRun.data?.datasetId;
  const sameDataset = useRuns({ dataset_id: datasetId, limit: 50 }, { enabled: !!datasetId });
  const targetProblem = targetRunId === id ? null : targetRunProblem({ isError: targetRun.isError, grid: targetRun.data?.grid });

  const [defaultBase, defaultTarget] = report.data ? defaultComparePair(report.data.cells, report.data.winner?.cellKey ?? null) : [null, null];
  const baseCell = sp.get('base') ?? defaultBase;
  const targetCell = sp.get('target') ?? (targetRunId === id ? defaultTarget : targetRun.data?.grid[0]?.cellKey ?? null);
  const filter = parseCompareFilter(sp.get('show'));
  const compare = useRunCompare(id ?? null, baseCell, targetRunId, targetCell);

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setSp(next, { replace: true });
  };

  if (report.isLoading || baseRun.isLoading) return <PageSpinner />;
  if (report.isError || !report.data || !baseRun.data) {
    return <Empty title="Run not found" description="This run does not exist or is not in your team." />;
  }

  const otherRuns = (sameDataset.data?.data ?? []).filter((r) => r.id !== id);
  const counts = compare.data?.counts;
  const changed = counts ? counts.improved + counts.regressed : 0;
  const shown = compare.data ? filterExamples(compare.data.examples, filter) : [];
  const chip = (key: CompareFilter, label: string, count: number | undefined, tone: string) => (
    <button
      key={key}
      type="button"
      onClick={() => setParams({ show: key })}
      aria-pressed={filter === key}
      data-testid={`compare-filter-${key}`}
      className={cn(
        'rounded-lg border px-3 py-1.5 text-[13px]',
        filter === key ? 'border-accent bg-elevated text-ink' : 'border-line bg-surface text-muted hover:text-ink',
      )}
    >
      <span className={tone}>{label}</span>
      <span className="ml-1.5 font-mono">{count ?? '—'}</span>
    </button>
  );

  return (
    <div className="flex flex-col gap-5">
      <Link to={`/evaluations/runs/${id}`} className="text-[12px] text-muted hover:text-ink">
        ← Run report
      </Link>

      <header>
        <h1 className="text-[20px] font-semibold tracking-tight">Compare per example</h1>
        <p className="mt-1 text-[13px] text-muted">
          Which examples the target fixed or broke against the base. An average can stay the same while both happen.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.06em] text-faint">Base</span>
          <CellSelect cells={baseRun.data.grid} value={baseCell ?? ''} onChange={(v) => setParams({ base: v })} label="Base cell" />
        </div>
        <span className="pb-2 text-faint">→</span>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.06em] text-faint">Target</span>
          <div className="flex flex-wrap gap-2">
            <Select
              value={targetRunId ?? ''}
              onChange={(e) => setParams({ target_run: e.target.value === id ? null : e.target.value, target: null })}
              className="w-56"
              aria-label="Target run"
              data-testid="compare-target-run"
            >
              <option value={id}>This run</option>
              {targetRunId && targetRunId !== id && !otherRuns.some((r) => r.id === targetRunId) && (
                // A linked target that is not in the newest 50 runs, or no longer exists, still
                // shows as selected instead of the select falling back to "This run".
                <option value={targetRunId}>{targetRun.data ? `Run ${targetRunId.slice(0, 8)}` : 'Run not found'}</option>
              )}
              {otherRuns.map((r) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.createdAt).toLocaleString()} · {r.promptName ?? r.experimentName ?? 'run'}
                </option>
              ))}
            </Select>
            {targetRun.data && (
              <CellSelect cells={targetRun.data.grid} value={targetCell ?? ''} onChange={(v) => setParams({ target: v })} label="Target cell" />
            )}
          </div>
        </div>
      </div>

      {report.data.cells.length < 2 && targetRunId === id ? (
        <Empty title="Nothing to compare in this run" description="It has one cell. Pick another run over the same dataset as the target." />
      ) : targetProblem === 'not-found' ? (
        <Empty title="Target run not found" description="It may have been deleted. Pick another target run above." />
      ) : targetProblem === 'no-cells' ? (
        <Empty title="Target run has no cells" description="It produced no results to compare. Pick another target run above." />
      ) : compare.isLoading || !targetCell ? (
        <PageSpinner />
      ) : compare.isError || !compare.data ? (
        <Empty title="Could not compare these cells" description={compareErrorText(compare.error)} />
      ) : (
        <>
          <div className="flex flex-wrap gap-2" data-testid="compare-counters">
            {chip('changed', 'Changed', changed, 'text-ink')}
            {CHANGE_ORDER.map((c) => chip(c, CHANGE_META[c].label, counts?.[c], CHANGE_META[c].tone))}
            {chip('all', 'All', compare.data.examples.length, 'text-ink')}
          </div>

          {shown.length === 0 ? (
            <Empty
              title={filter === 'changed' ? 'No example changed' : 'No examples here'}
              description={
                filter === 'changed'
                  ? 'Every example has the same pass or fail verdict in both cells.'
                  : 'Pick another counter above to see other examples.'
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full min-w-[520px] table-fixed border-collapse text-left text-[13px]" data-testid="compare-table">
                <thead>
                  <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.06em] text-faint">
                    <th className="w-9 px-3 py-2.5" />
                    <th className="px-3 py-2.5 font-medium">Input</th>
                    <th className="w-24 px-3 py-2.5 font-medium" title={cellLabel(compare.data.base)}>Base</th>
                    <th className="w-24 px-3 py-2.5 font-medium" title={cellLabel(compare.data.target)}>Target</th>
                    <th className="w-[72px] px-3 py-2.5 text-right font-medium">Δ</th>
                    <th className="w-[104px] px-3 py-2.5 font-medium">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((e) => (
                    <CompareRow key={e.exampleId} example={e} baseTitle={cellLabel(compare.data.base)} targetTitle={cellLabel(compare.data.target)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
