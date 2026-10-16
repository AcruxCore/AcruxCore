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
  expected: unknown;
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
    scores: row.scores,
  };
}

/**
 * Re-points a row's `score`/`passed`/`reason` at one of its named scores, so
 * the pairing below classifies on that score (phase-5 FAQ Q46). A row that
 * lacks the name reads as unscored, never as a fail.
 *
 * @param row - One cell's result.
 * @param name - The named score to classify on.
 * @returns The row with its primary fields taken from that score.
 */
export function selectNamedScore(row: CompareResultRow, name: string): CompareResultRow {
  const named = row.scores.find((s) => s.name === name);
  return {
    ...row,
    score: named?.score ?? null,
    passed: named?.passed ?? null,
    reason: named?.reason ?? null,
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
      expected: row.expected,
      base,
      target,
      scoreDelta: base?.score != null && target?.score != null ? target.score - base.score : null,
      change,
    };
  });
  return { counts, examples };
}
