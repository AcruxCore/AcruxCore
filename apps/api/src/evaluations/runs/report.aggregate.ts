import type {
  BuildRunReportInput,
  EvalResultRow,
  ReportGridCell,
  RunReport,
  RunReportCell,
  RunReportDelta,
  RunReportVariant,
  RunReportWinner,
} from './report.types';

/**
 * Regression-label noise threshold, in score points. A candidate/baseline
 * delta smaller than this in magnitude is reported as `'flat'` rather than
 * `'improved'`/`'regressed'` (spec §Report read model).
 */
const REGRESSION_EPSILON = 2;

/** Per-cell aggregate before the cross-cell (baseline delta / leaderboard / winner) pass. */
interface CellAggregate {
  cellKey: string;
  variantLabel: string;
  model: string;
  isProductionBaseline: boolean;
  avgScore: number | null;
  passRate: number | null;
  exampleCount: number;
  scoredCount: number;
  unscoredCount: number;
}

/**
 * Reduces a grid cell's `eval_result` rows to its scored aggregates.
 *
 * @param rows - The result rows belonging to this one (variantLabel, model) cell.
 * @returns Counts plus `avgScore`/`passRate`, both `null` when nothing scored.
 */
function aggregateRows(rows: EvalResultRow[]): {
  avgScore: number | null;
  passRate: number | null;
  exampleCount: number;
  scoredCount: number;
  unscoredCount: number;
} {
  const scored = rows.filter((row) => row.score !== null);
  const scoredCount = scored.length;
  const unscoredCount = rows.length - scoredCount;
  const avgScore =
    scoredCount > 0 ? scored.reduce((sum, row) => sum + (row.score as number), 0) / scoredCount : null;
  const passCount = scored.filter((row) => row.passed === true).length;
  const passRate = scoredCount > 0 ? passCount / scoredCount : null;
  return { avgScore, passRate, exampleCount: rows.length, scoredCount, unscoredCount };
}

/**
 * Derives the report's prompt-variant axis from the grid: one entry per
 * distinct `variantLabel`, independent of which models it was run against.
 *
 * @param grid - The run's resolved (variant × model) cells.
 * @returns The distinct variants, in first-seen order.
 */
function deriveVariants(grid: ReportGridCell[]): RunReportVariant[] {
  const seen = new Map<string, RunReportVariant>();
  for (const cell of grid) {
    if (!seen.has(cell.variantLabel)) {
      seen.set(cell.variantLabel, {
        variantKind: cell.variantKind as RunReportVariant['variantKind'],
        promptVersionId: cell.promptVersionId,
        variantLabel: cell.variantLabel,
        isProductionBaseline: cell.isProductionBaseline,
      });
    }
  }
  return Array.from(seen.values());
}

/**
 * Computes a cell's delta vs. the same-model production-baseline cell.
 *
 * @param cell - The non-baseline cell's aggregate.
 * @param baseline - The same-model baseline cell's aggregate, or `undefined`
 *   if the grid carries no baseline for this model.
 * @returns `{ score: null, passRate: null, label: 'unknown' }` when either
 *   side has zero scored examples (the delta is not computable — never a
 *   fake zero); otherwise the signed score/pass-rate deltas and a label from
 *   {@link REGRESSION_EPSILON}.
 */
function computeDelta(cell: CellAggregate, baseline: CellAggregate | undefined): RunReportDelta {
  if (!baseline || cell.avgScore === null || baseline.avgScore === null) {
    return { score: null, passRate: null, label: 'unknown' };
  }
  const scoreDelta = cell.avgScore - baseline.avgScore;
  const passRateDelta =
    cell.passRate !== null && baseline.passRate !== null ? cell.passRate - baseline.passRate : null;
  const label: RunReportDelta['label'] =
    scoreDelta >= REGRESSION_EPSILON ? 'improved' : scoreDelta <= -REGRESSION_EPSILON ? 'regressed' : 'flat';
  return { score: scoreDelta, passRate: passRateDelta, label };
}

/**
 * Builds the full comparison report for a run: a (variant × model) matrix of
 * per-cell averages, each non-baseline cell's regression delta vs. the
 * same-model production baseline, a leaderboard, and an advisory winner.
 *
 * Pure and DB-free — grouping/aggregation only, over already-loaded rows.
 * The grid (not the results) is the source of truth for which cells exist,
 * so a cell with zero results yet still appears with `avgScore: null`.
 *
 * @param input - `run` (id/status/grid) and the run's `eval_result` rows.
 * @returns The computed {@link RunReport}.
 */
export function buildRunReport(input: BuildRunReportInput): RunReport {
  const { run, results } = input;

  const rowsByCellKey = new Map<string, EvalResultRow[]>();
  for (const cell of run.grid) {
    rowsByCellKey.set(cell.cellKey, []);
  }
  for (const row of results) {
    const cellKey = `${row.variantLabel}|${row.model}`;
    rowsByCellKey.get(cellKey)?.push(row);
  }

  const aggregates: CellAggregate[] = run.grid.map((cell) => ({
    cellKey: cell.cellKey,
    variantLabel: cell.variantLabel,
    model: cell.model,
    isProductionBaseline: cell.isProductionBaseline,
    ...aggregateRows(rowsByCellKey.get(cell.cellKey) ?? []),
  }));

  const baselineByModel = new Map<string, CellAggregate>();
  for (const agg of aggregates) {
    if (agg.isProductionBaseline) {
      baselineByModel.set(agg.model, agg);
    }
  }

  const cells: RunReportCell[] = aggregates.map((agg) => ({
    cellKey: agg.cellKey,
    variantLabel: agg.variantLabel,
    model: agg.model,
    isProductionBaseline: agg.isProductionBaseline,
    avgScore: agg.avgScore,
    passRate: agg.passRate,
    exampleCount: agg.exampleCount,
    scoredCount: agg.scoredCount,
    unscoredCount: agg.unscoredCount,
    deltaVsBaseline: agg.isProductionBaseline ? null : computeDelta(agg, baselineByModel.get(agg.model)),
  }));

  const leaderboard = [...cells]
    .sort((a, b) => {
      if (a.avgScore === null && b.avgScore === null) return 0;
      if (a.avgScore === null) return 1;
      if (b.avgScore === null) return -1;
      if (b.avgScore !== a.avgScore) return b.avgScore - a.avgScore;
      // Tie on avgScore: break by pass rate, matching the `winner` tiebreak
      // below so leaderboard[0] and winner never disagree on a tie.
      return (b.passRate ?? 0) - (a.passRate ?? 0);
    })
    .map((cell) => cell.cellKey);

  const scoredCells = cells.filter((cell) => cell.avgScore !== null);
  let winner: RunReportWinner | null = null;
  if (scoredCells.length > 0) {
    const top = scoredCells.reduce((best, cell) => {
      if (cell.avgScore! > best.avgScore!) return cell;
      if (cell.avgScore! === best.avgScore! && (cell.passRate ?? 0) > (best.passRate ?? 0)) return cell;
      return best;
    });
    winner = {
      cellKey: top.cellKey,
      variantLabel: top.variantLabel,
      model: top.model,
      avgScore: top.avgScore as number,
    };
  }

  return {
    runId: run.id,
    status: run.status,
    models: Array.from(new Set(run.grid.map((cell) => cell.model))),
    variants: deriveVariants(run.grid),
    cells,
    leaderboard,
    winner,
  };
}
