import { Link } from 'react-router-dom';
import { Spinner } from '@/ui';
import type { RunListItem } from '@/api/types';
import { timeAgo, dateTime } from '@/lib/format';
import {
  formatDuration,
  formatPassRate,
  formatScore,
  runResultsLine,
  runSubtitle,
  runStatusChip,
  runTitle,
} from './run-history.helpers';

export interface RunHistoryTableProps {
  runs: RunListItem[];
}

/** The status cell: a coloured dot plus its label, with a spinner while the run is still working. */
function StatusCell({ run }: { run: RunListItem }) {
  const chip = runStatusChip(run.status);
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px]" data-testid="run-status" data-status={run.status}>
      {chip.inFlight ? <Spinner /> : <span className={`h-2 w-2 rounded-full ${chip.dot}`} aria-hidden />}
      <span className={chip.text}>{chip.label}</span>
    </span>
  );
}

/**
 * The run-history table: one row per run, newest first, each linking to its
 * comparison report. Scores read as an em dash rather than a zero until the
 * judge has scored something, matching the report's own unscored cells.
 *
 * @param runs - The page of runs to render (already ordered by the API).
 */
export function RunHistoryTable({ runs }: RunHistoryTableProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[760px] border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.06em] text-faint">
            <th className="px-4 py-2.5 font-medium">Run</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 text-right font-medium">Score</th>
            <th className="px-4 py-2.5 font-medium">Best</th>
            <th className="px-4 py-2.5 text-right font-medium">Duration</th>
            <th className="px-4 py-2.5 text-right font-medium">Started</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const passRate = formatPassRate(run.passRate);
            return (
              <tr
                key={run.id}
                className="border-b border-line-soft bg-surface last:border-b-0 hover:bg-elevated"
                data-testid="run-history-row"
              >
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/evaluations/runs/${run.id}`}
                      className="font-medium text-ink hover:text-accent"
                      data-testid="run-history-link"
                    >
                      {runTitle(run)}
                    </Link>
                    {run.kind === 'optimize' && (
                      <span className="rounded-full border border-accent/45 px-2 py-0.5 font-mono text-[11px] text-ink">
                        optimize
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12px] text-muted" title={runResultsLine(run)}>
                    {runSubtitle(run)}
                  </p>
                </td>
                <td className="px-4 py-2.5">
                  <StatusCell run={run} />
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className="font-mono text-ink">{formatScore(run.avgScore)}</span>
                  {passRate && <p className="mt-0.5 text-[12px] text-muted">{passRate}</p>}
                </td>
                <td className="px-4 py-2.5">
                  <span className="font-mono text-[12px] text-muted">{run.topVariantLabel ?? '—'}</span>
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-muted">{formatDuration(run.durationMs)}</td>
                <td className="px-4 py-2.5 text-right text-muted" title={dateTime(run.createdAt)}>
                  {timeAgo(run.createdAt)}
                  {run.startedBy && <p className="mt-0.5 text-[12px] text-faint">{run.startedBy.name}</p>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
