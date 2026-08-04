import type { RunListResultCounts, RunVariantAggregate } from './runs.types';

/** A grid cell as far as the history list cares: what kind of variant it holds, and which model. */
interface ShapeGridCell {
  variantKind: string;
  variantLabel: string;
  model: string;
}

/** The score-derived half of a history row, folded from one run's variant aggregates. */
export interface RunScoreSummary {
  results: RunListResultCounts;
  /** Mean judge score across every scored result, 0–100, rounded to 1dp. Null when nothing is scored. */
  avgScore: number | null;
  /** Share of scored results the judge passed, 0–1, rounded to 3dp. Null when nothing is scored. */
  passRate: number | null;
  /** The highest-mean-score variant label. Null when nothing is scored. */
  topVariantLabel: string | null;
}

/** The frozen grid's shape, as shown under a history row's title. */
export interface RunGridShape {
  variantCount: number;
  modelCount: number;
}

/**
 * Folds one run's per-variant aggregates into the numbers a history row shows.
 *
 * Deliberately never invents a `0`: a run whose results are all unscored (no
 * criterion on the examples, or a judge parse error) reports `null` scores with
 * real counts, the same distinction the comparison report draws between an
 * unscored cell and a cell that scored zero.
 *
 * @param groups - Every aggregate row belonging to one run. Empty for a run
 *   that has produced no results yet (queued, or failed before its first cell).
 * @returns Result counts plus mean score, pass rate, and best variant.
 */
export function foldRunScores(groups: RunVariantAggregate[]): RunScoreSummary {
  const total = groups.reduce((sum, g) => sum + g.total, 0);
  const errored = groups.reduce((sum, g) => sum + g.errored, 0);
  const scored = groups.reduce((sum, g) => sum + g.scored, 0);
  const scoreSum = groups.reduce((sum, g) => sum + g.scoreSum, 0);
  const passed = groups.reduce((sum, g) => sum + g.passed, 0);

  return {
    results: { total, succeeded: total - errored, errored, scored },
    avgScore: scored === 0 ? null : round(scoreSum / scored, 1),
    passRate: scored === 0 ? null : round(passed / scored, 3),
    topVariantLabel: topVariant(groups),
  };
}

/**
 * Picks the best-scoring variant label among a run's aggregates: highest mean
 * score, ties broken by label so the answer is stable across calls (a run with
 * two identically-scoring variants must not flip between page loads).
 * Variants with nothing scored are ignored entirely — an unscored variant is
 * not a zero-scoring one.
 *
 * @param groups - One run's aggregate rows.
 * @returns The winning variant label, or null when no variant has a score.
 */
function topVariant(groups: RunVariantAggregate[]): string | null {
  const scoredGroups = groups.filter((g) => g.scored > 0);
  if (scoredGroups.length === 0) return null;

  return scoredGroups.reduce((best, g) => {
    const bestMean = best.scoreSum / best.scored;
    const mean = g.scoreSum / g.scored;
    if (mean > bestMean) return g;
    if (mean === bestMean && g.variantLabel < best.variantLabel) return g;
    return best;
  }).variantLabel;
}

/**
 * Reads a run's kind off its frozen grid. An optimize run (E6) is an ordinary
 * `experiment_runs` row — the only thing that marks it is at least one
 * optimizer-drafted `candidate` cell, so the kind is derived here rather than
 * stored on the row where it could drift from the grid's contents.
 *
 * @param grid - The run's frozen grid cells (empty on an optimize run whose
 *   candidates have not been drafted yet, which therefore reads as
 *   `'evaluation'` until the optimizer fills the grid in).
 * @returns `'optimize'` if any cell is a candidate, else `'evaluation'`.
 */
export function deriveRunKind(grid: ShapeGridCell[]): 'evaluation' | 'optimize' {
  return grid.some((cell) => cell.variantKind === 'candidate') ? 'optimize' : 'evaluation';
}

/**
 * Counts the distinct axes of a run's frozen grid — the "3 variants × 2 models"
 * line under a history row. Counts distinct labels/models rather than cells,
 * since the grid holds one cell per pair.
 *
 * @param grid - The run's frozen grid cells.
 * @returns Distinct variant-label and model counts (both `0` for an empty grid).
 */
export function deriveGridShape(grid: ShapeGridCell[]): RunGridShape {
  return {
    variantCount: new Set(grid.map((cell) => cell.variantLabel)).size,
    modelCount: new Set(grid.map((cell) => cell.model)).size,
  };
}

/** Rounds to `decimals` places, avoiding the trailing float noise of a bare division. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
