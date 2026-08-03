import { Fragment } from 'react';
import { Badge } from '@/ui';
import { cn } from '@/lib/cn';
import type { RunReport, RunReportCell } from '@/api/types';
import { deltaToChip, scoreToGrade, type DeltaTone, type ScoreGrade } from './matrix.helpers';

export interface LeaderboardMatrixProps {
  report: RunReport;
  /** The cellKey currently open in the drill-down panel, or null if none. */
  selectedCellKey: string | null;
  /** Called with a cell's `cellKey` when the user activates it (click or Enter/Space). */
  onSelectCell: (cellKey: string) => void;
}

/**
 * Visual treatment per score grade — background tint, text/number color, a
 * solid bar-fill color (for the leaderboard's diagnostic bar), and the
 * always-present text label (color is never the only signal). Every class
 * is a literal string (never built via string concatenation) so Tailwind's
 * static content scan picks it up.
 */
const GRADE_STYLE: Record<ScoreGrade, { bg: string; text: string; bar: string; label: string }> = {
  unscored: { bg: 'bg-faint/5 border-dashed', text: 'text-faint', bar: 'bg-faint', label: 'Unscored' },
  low: { bg: 'bg-danger/10', text: 'text-danger', bar: 'bg-danger', label: 'Low' },
  mid: { bg: 'bg-warn/10', text: 'text-warn', bar: 'bg-warn', label: 'Mid' },
  high: { bg: 'bg-ok/10', text: 'text-ok', bar: 'bg-ok', label: 'High' },
};

/** Visual treatment per regression-delta tone — a directional glyph plus a text color (never color alone). */
const DELTA_STYLE: Record<DeltaTone, { text: string; glyph: string }> = {
  up: { text: 'text-ok', glyph: '▲' },
  down: { text: 'text-danger', glyph: '▼' },
  flat: { text: 'text-muted', glyph: '–' },
  unknown: { text: 'text-faint', glyph: '?' },
};

/** Clamp a raw judge score into a 0–100 bar width; unscored cells get no bar. */
function barWidthPct(score: number | null): number {
  if (score === null) return 0;
  return Math.max(2, Math.min(100, score));
}

/** One row of the ranked leaderboard: rank ordinal, variant/model, score, and a diagnostic-style fill bar. */
function LeaderboardRow({
  rank,
  cell,
  isWinner,
  isSelected,
  onSelect,
}: {
  rank: number;
  cell: RunReportCell;
  isWinner: boolean;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const grade = scoreToGrade(cell.avgScore);
  const style = GRADE_STYLE[grade];
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={isSelected}
        data-testid="leaderboard-row"
        className={cn(
          'flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
          'border-line-soft bg-surface hover:bg-elevated',
          isSelected && 'border-accent/60 ring-1 ring-accent/40',
        )}
      >
        <span className="w-7 shrink-0 font-mono text-[12px] text-faint">#{rank}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">
            {cell.variantLabel} <span className="text-faint">·</span> <span className="font-mono">{cell.model}</span>
          </span>
          <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-line-soft">
            <span
              className={cn('block h-full rounded-full', style.bar)}
              style={{ width: `${barWidthPct(cell.avgScore)}%` }}
            />
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className={cn('block font-mono text-[13px] font-semibold', style.text)}>
            {cell.avgScore === null ? '—' : cell.avgScore.toFixed(1)}
          </span>
          {isWinner && <span className="block text-[11px] font-medium text-accent">★ Top</span>}
        </span>
      </button>
    </li>
  );
}

/** One matrix cell: grade-tinted tile with the numeric score, grade label, and (for non-baseline cells) the regression chip. */
function MatrixCell({
  cell,
  isSelected,
  onSelect,
}: {
  cell: RunReportCell;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const grade = scoreToGrade(cell.avgScore);
  const gradeStyle = GRADE_STYLE[grade];
  const chip = deltaToChip(cell.deltaVsBaseline);
  const deltaStyle = DELTA_STYLE[chip.tone];

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      data-testid="matrix-cell"
      className={cn(
        'flex w-full min-w-[128px] flex-col items-start gap-1 rounded-md border px-2.5 py-2 text-left transition-colors',
        'border-line-soft',
        gradeStyle.bg,
        'hover:border-accent/50',
        isSelected && 'border-accent ring-1 ring-accent/50',
      )}
    >
      <span className={cn('font-mono text-[15px] font-semibold leading-none', gradeStyle.text)}>
        {cell.avgScore === null ? '—' : cell.avgScore.toFixed(1)}
      </span>
      <span className={cn('text-[11px] uppercase tracking-[0.04em]', gradeStyle.text)}>{gradeStyle.label}</span>
      <span className="text-[11px] text-faint">
        {cell.scoredCount}/{cell.exampleCount} scored
      </span>
      {cell.isProductionBaseline ? (
        <Badge tone="prod" dot className="mt-0.5 px-2 py-0.5 text-[10px]">
          Baseline
        </Badge>
      ) : (
        <span className={cn('mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium', deltaStyle.text)}>
          <span aria-hidden>{deltaStyle.glyph}</span>
          {chip.label}
        </span>
      )}
    </button>
  );
}

/**
 * The matrix leaderboard: a ranked list of every (prompt-variant × model)
 * cell by average score, above a full variant-rows × model-columns grid.
 * Cells are color-graded by {@link scoreToGrade} (paired with the numeric
 * score and a text label — color is never the only signal), the
 * production-baseline row carries a `Baseline` badge instead of a delta
 * chip, and every other cell shows its regression delta vs. that baseline.
 * Clicking any cell or leaderboard row invokes `onSelectCell` with the
 * cell's key so the caller can open the drill-down panel.
 *
 * @param report - The run's comparison report (`GET /runs/:id/report`).
 * @param selectedCellKey - The currently drilled-down cell's key, for the selection ring.
 * @param onSelectCell - Invoked with a cell's `cellKey` on click/activation.
 */
export function LeaderboardMatrix({ report, selectedCellKey, onSelectCell }: LeaderboardMatrixProps) {
  const cellsByKey = new Map(report.cells.map((c) => [c.cellKey, c]));
  const ranked = report.leaderboard.map((key) => cellsByKey.get(key)).filter((c): c is RunReportCell => !!c);

  return (
    <div className="flex flex-col gap-6">
      {ranked.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.06em] text-faint">Leaderboard</h2>
          <ol className="flex flex-col gap-1.5" data-testid="leaderboard-list">
            {ranked.map((cell, i) => (
              <LeaderboardRow
                key={cell.cellKey}
                rank={i + 1}
                cell={cell}
                isWinner={report.winner?.cellKey === cell.cellKey}
                isSelected={selectedCellKey === cell.cellKey}
                onSelect={() => onSelectCell(cell.cellKey)}
              />
            ))}
          </ol>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.06em] text-faint">Matrix</h2>
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-max border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.06em] text-faint">
                <th className="sticky left-0 z-10 bg-surface px-4 py-2.5 font-medium">Variant</th>
                {report.models.map((model) => (
                  <th key={model} className="px-2.5 py-2.5 font-mono font-medium normal-case">
                    {model}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.variants.map((variant) => (
                <Fragment key={variant.variantLabel}>
                  <tr className="border-b border-line-soft last:border-b-0">
                    <td className="sticky left-0 z-10 whitespace-nowrap bg-surface px-4 py-2.5 align-top">
                      <span className="text-[13px] font-medium text-ink">{variant.variantLabel}</span>
                      {variant.isProductionBaseline && (
                        <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" aria-hidden />
                      )}
                    </td>
                    {report.models.map((model) => {
                      const cellKey = `${variant.variantLabel}|${model}`;
                      const cell = cellsByKey.get(cellKey);
                      return (
                        <td key={model} className="px-1.5 py-1.5 align-top">
                          {cell ? (
                            <MatrixCell
                              cell={cell}
                              isSelected={selectedCellKey === cell.cellKey}
                              onSelect={() => onSelectCell(cell.cellKey)}
                            />
                          ) : (
                            <span className="block px-2.5 py-2 text-[12px] text-faint">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
