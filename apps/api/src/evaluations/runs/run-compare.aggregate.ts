import type {
  RunCompareChange,
  RunCompareExampleDto,
  RunCompareSide,
} from './runs.types';

/** One cell's result for one example, as the compare pairing needs it. */
export interface CompareResultRow extends RunCompareSide {
  datasetExampleId: string;
  input: Record<string, unknown>;
  criteria: string | null;
}

/**
 * Classifies one example's move from base to target on pass/fail alone.
 *
 * @param base - The base cell's result, or null when it has none for this example.
 * @param target - The target cell's result, or null likewise.
 * @returns `missing` when a side has no result, `unscored` when a side has no verdict,
 *          otherwise `improved` (fail → pass), `regressed` (pass → fail) or `unchanged`.
 */
export function classifyChange(base: RunCompareSide | null, target: RunCompareSide | null): RunCompareChange {
  if (!base || !target) return 'missing';
  if (base.passed === null || target.passed === null) return 'unscored';
  if (base.passed === target.passed) return 'unchanged';
  return target.passed ? 'improved' : 'regressed';
}

/** Strips the pairing-only fields off a row, leaving what the response shows per side. */
function toSide(row: CompareResultRow): RunCompareSide {
  return {
    output: row.output,
    errorMessage: row.errorMessage,
    score: row.score,
    passed: row.passed,
    reason: row.reason,
    traceId: row.traceId,
  };
}

/**
 * Pairs two cells' results by dataset example and counts how each example moved.
 *
 * Examples keep the base cell's order, then any that only the target has. The input and
 * criteria shown are the base side's when it has one: both runs graded the same dataset
 * example, and the base is the side the reader is comparing against.
 *
 * @param baseRows - Every result of the base cell.
 * @param targetRows - Every result of the target cell.
 * @returns The paired examples and a count per change, which always sum to the
 *          number of examples.
 */
export function compareCells(
  baseRows: CompareResultRow[],
  targetRows: CompareResultRow[],
): { counts: Record<RunCompareChange, number>; examples: RunCompareExampleDto[] } {
  const targetById = new Map(targetRows.map((r) => [r.datasetExampleId, r]));
  const baseIds = new Set(baseRows.map((r) => r.datasetExampleId));
  const ordered = [...baseRows, ...targetRows.filter((r) => !baseIds.has(r.datasetExampleId))];

  const counts: Record<RunCompareChange, number> = { improved: 0, regressed: 0, unchanged: 0, unscored: 0, missing: 0 };
  const examples = ordered.map((row): RunCompareExampleDto => {
    const baseRow = baseIds.has(row.datasetExampleId) ? row : null;
    const targetRow = targetById.get(row.datasetExampleId) ?? null;
    const base = baseRow ? toSide(baseRow) : null;
    const target = targetRow ? toSide(targetRow) : null;
    const change = classifyChange(base, target);
    counts[change] += 1;
    return {
      exampleId: row.datasetExampleId,
      input: row.input,
      criteria: row.criteria,
      base,
      target,
      scoreDelta: base?.score != null && target?.score != null ? target.score - base.score : null,
      change,
    };
  });
  return { counts, examples };
}
