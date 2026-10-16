import type { RunReportCell } from '@/api/types';

/** `70.0` for a 0–100 mean, `—` when nothing carried the score. */
function formatMean(value: number | null): string {
  return value === null ? '—' : value.toFixed(1);
}

/** `1 of 2 passed (50%)`, or `—` when nothing was scored. */
function formatPassRate(passRate: number | null, scored: number): string {
  if (passRate === null || scored === 0) return '—';
  const passed = Math.round(passRate * scored);
  return `${passed} of ${scored} passed (${Math.round(passRate * 100)}%)`;
}

/**
 * The per-score breakdown of a local run's report: one row per (cell × named
 * score), so `items_exact`, `total_exact` and a judge score each show how they
 * did. The matrix above it shows only the primary score; this is where the
 * other checks are read. Renders nothing when no cell has named scores (a
 * server-side run).
 *
 * @param cells - The report's cells.
 */
export function NamedScoreTable({ cells }: { cells: RunReportCell[] }) {
  const rows = cells.flatMap((cell) => (cell.namedScores ?? []).map((score) => ({ cell, score })));
  if (rows.length === 0) return null;
  const showCell = cells.length > 1;
  return (
    <section className="flex flex-col gap-2" data-testid="named-score-table">
      <h2 className="text-[14px] font-semibold text-ink">Scores</h2>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[420px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.06em] text-faint">
              {showCell && <th className="px-3 py-2.5 font-medium">Cell</th>}
              <th className="px-3 py-2.5 font-medium">Scorer</th>
              <th className="px-3 py-2.5 text-right font-medium">Mean (0–100)</th>
              <th className="px-3 py-2.5 font-medium">Passed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ cell, score }) => (
              <tr key={`${cell.cellKey}:${score.name}`} className="border-b border-line-soft bg-surface last:border-b-0" data-testid="named-score-row">
                {showCell && <td className="px-3 py-2.5 text-muted">{cell.variantLabel} · {cell.model}</td>}
                <td className="px-3 py-2.5 font-mono text-ink">{score.name}</td>
                <td className="px-3 py-2.5 text-right font-mono">{formatMean(score.avgScore)}</td>
                <td className="px-3 py-2.5 text-muted">{formatPassRate(score.passRate, score.scoredCount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
