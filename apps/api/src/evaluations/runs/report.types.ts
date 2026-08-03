/**
 * One (variant × model) cell of a run's grid, as produced by the run-start
 * orchestration (E3) and passed in as input to the report aggregator.
 * Fields are typed permissively (`string` rather than a literal union) since
 * the grid is read-model input, not something this module constrains.
 */
export interface ReportGridCell {
  cellKey: string;
  variantKind: string;
  promptVersionId: string | null;
  variantLabel: string;
  model: string;
  isProductionBaseline: boolean;
}

/**
 * One `eval_result` row (per dataset example × cell) as read from storage.
 * `score`/`passed` are `null` when the example is unscored (E4 judge
 * parse-error or no criterion) — never a fake `0`/`false`.
 */
export interface EvalResultRow {
  datasetExampleId: string;
  variantLabel: string;
  variantKind: string;
  model: string;
  isProductionBaseline?: boolean;
  score: number | null;
  passed: boolean | null;
}

/** Input to {@link buildRunReport}. */
export interface BuildRunReportInput {
  run: {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    grid: ReportGridCell[];
  };
  results: EvalResultRow[];
}

/**
 * One entry on the report's prompt-variant axis — the distinct
 * (variantKind, variantLabel) pairs present in the run's grid, independent
 * of which models they were run against.
 */
export interface RunReportVariant {
  variantKind: 'version' | 'candidate';
  promptVersionId: string | null;
  variantLabel: string;
  isProductionBaseline: boolean;
}

/**
 * A cell's score/pass-rate delta versus the same-model production-baseline
 * cell. `null` on the baseline cell itself (there is nothing to compare it
 * to). `label: 'unknown'` when either side has zero scored examples — the
 * delta is not computable, not zero.
 */
export interface RunReportDelta {
  score: number | null;
  passRate: number | null;
  label: 'improved' | 'regressed' | 'flat' | 'unknown';
}

/** One (variantLabel × model) cell of the report matrix, with its aggregates. */
export interface RunReportCell {
  cellKey: string;
  variantLabel: string;
  model: string;
  isProductionBaseline: boolean;
  avgScore: number | null;
  passRate: number | null;
  exampleCount: number;
  scoredCount: number;
  unscoredCount: number;
  deltaVsBaseline: RunReportDelta | null;
}

/** The top-ranked scored cell. The `model` is advisory (FAQ Q11) — recorded, not pinned. */
export interface RunReportWinner {
  cellKey: string;
  variantLabel: string;
  model: string;
  avgScore: number;
}

/**
 * The full computed report for a run: a (variant × model) matrix with
 * per-cell averages, regression deltas vs. the production baseline, a
 * leaderboard, and an advisory winner. Computed on read from `eval_result`
 * rows — there is no dedicated report table.
 */
export interface RunReport {
  runId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  models: string[];
  variants: RunReportVariant[];
  cells: RunReportCell[];
  leaderboard: string[];
  winner: RunReportWinner | null;
}
