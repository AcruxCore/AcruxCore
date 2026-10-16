import type { RunCompareChange, RunCompareExample, RunReportCell } from '@/api/types';
import { ApiError } from '@/api/client';

/**
 * Which examples the compare table shows. `changed` is the two directions together —
 * the filter a reader wants first, since an average hides exactly these rows.
 */
export type CompareFilter = 'all' | 'changed' | RunCompareChange;

/** Parses the `show` URL param, falling back to `changed` for anything unknown. */
export function parseCompareFilter(value: string | null): CompareFilter {
  const known: CompareFilter[] = ['all', 'changed', 'improved', 'regressed', 'unchanged', 'unscored', 'missing'];
  return known.includes(value as CompareFilter) ? (value as CompareFilter) : 'changed';
}

/**
 * Narrows the paired examples to one filter.
 *
 * @param examples - Every paired example from the compare response.
 * @param filter - `all`, `changed` (improved or regressed), or one change kind.
 * @returns The examples to show, in response order.
 */
export function filterExamples(examples: RunCompareExample[], filter: CompareFilter): RunCompareExample[] {
  if (filter === 'all') return examples;
  if (filter === 'changed') return examples.filter((e) => e.change === 'improved' || e.change === 'regressed');
  return examples.filter((e) => e.change === filter);
}

/**
 * Picks the pair of cells a compare page opens on when the URL names none: the
 * production baseline against the best other cell on the same model, else the first
 * two cells of the run.
 *
 * @param cells - The run report's cells.
 * @param winnerKey - The report's winner cell key, if any.
 * @returns `[base, target]` cell keys, or nulls when the run has fewer than two cells.
 */
export function defaultComparePair(
  cells: RunReportCell[],
  winnerKey: string | null,
): [string | null, string | null] {
  if (cells.length < 2) return [cells[0]?.cellKey ?? null, null];
  const baseline = cells.find((c) => c.isProductionBaseline) ?? cells[0];
  const sameModel = cells.filter((c) => c.cellKey !== baseline.cellKey && c.model === baseline.model);
  const winner = sameModel.find((c) => c.cellKey === winnerKey);
  const target = winner ?? sameModel[0] ?? cells.find((c) => c.cellKey !== baseline.cellKey)!;
  return [baseline.cellKey, target.cellKey];
}

/** Why the chosen target run cannot be compared, or null when it can (or is still loading). */
export type TargetRunProblem = 'not-found' | 'no-cells';

/**
 * Checks the target run before the page waits on a compare call it can never make.
 * Without this, a link to a deleted run, or to a run with an empty grid, left
 * `targetCell` null and the page spinning forever.
 *
 * @param target - The target run query's error flag and, once loaded, its grid.
 * @returns `not-found` when the run failed to load, `no-cells` when its grid is empty,
 *          else null.
 */
export function targetRunProblem(target: { isError: boolean; grid: { cellKey: string }[] | undefined }): TargetRunProblem | null {
  if (target.isError) return 'not-found';
  if (target.grid && target.grid.length === 0) return 'no-cells';
  return null;
}

/**
 * Turns a failed compare call into text for the reader. Only a real
 * `DATASET_MISMATCH` blames the datasets; a 404 means a cell key in the URL is not in
 * its run (a stale or edited link), which needs a different fix.
 *
 * @param error - The compare query's error, usually an {@link ApiError}.
 * @returns One sentence saying what went wrong and what to do.
 */
export function compareErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code === 'DATASET_MISMATCH') {
    return 'Both cells must come from runs over the same dataset.';
  }
  if (error instanceof ApiError && error.code === 'SCORE_NOT_FOUND') {
    return 'Neither run has the score named in this link, so there is nothing to compare it on.';
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'A cell in this link is not in its run. Pick the cells again above.';
  }
  return error instanceof Error ? error.message : 'The comparison could not be loaded.';
}

/** URL keys whose change picks a different pair of cells, which may not share the picked score. */
const PAIR_KEYS = ['base', 'target', 'target_run'];

/**
 * The compare page's next search params after `patch` (a `null` value removes the
 * key). Changing the base, the target run or the target cell also clears `score`:
 * the new pair may have no score of that name, and a stale one would mark every
 * example unscored, or fail the comparison and hide the picker that could clear it.
 *
 * @param current - The page's current search params; not modified.
 * @param patch - Keys to set, or `null` to remove.
 * @returns A new `URLSearchParams`.
 */
export function nextCompareParams(current: URLSearchParams, patch: Record<string, string | null>): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) next.delete(k);
    else next.set(k, v);
  }
  if (!('score' in patch) && Object.keys(patch).some((k) => PAIR_KEYS.includes(k))) next.delete('score');
  return next;
}
