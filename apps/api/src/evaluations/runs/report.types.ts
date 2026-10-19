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
  /** A local run's named scores (phase-5 FAQ Q46); null or absent on a server-side result. */
  scores?: ReportNamedScoreInput[] | null;
  /** Why the candidate call failed, when it did. Absent on rows read before #576. */
  errorMessage?: string | null;
  /** The judge's reasoning, or its "judge call failed: …" marker when grading failed. */
  reason?: string | null;
}

/** One named score as stored on a local result, as far as the report reads it. */
export interface ReportNamedScoreInput {
  name: string;
  score: number | null;
  passed: boolean | null;
}

/**
 * One named score's aggregate over a cell's results — how a local run's
 * `items_exact`, `total_exact` and judge score each did. Empty list on a
 * server-side cell, which has one judge score only.
 */
export interface RunReportNamedScore {
  name: string;
  /** Mean 0–100 over the results that carry this score with a value. Null when none do. */
  avgScore: number | null;
  /** Share of those results that passed, 0–1. Null when none are scored. */
  passRate: number | null;
  scoredCount: number;
}

/** Input to {@link buildRunReport}. */
export interface BuildRunReportInput {
  run: {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    grid: ReportGridCell[];
  };
  results: EvalResultRow[];
  /**
   * Version number per `promptVersionId` in the grid. Optional: a variant whose
   * id is missing here reports `versionNumber: null`.
   */
  versionNumbers?: Record<string, number>;
}

/**
 * One entry on the report's prompt-variant axis — the distinct
 * (variantKind, variantLabel) pairs present in the run's grid, independent
 * of which models they were run against.
 */
export interface RunReportVariant {
  variantKind: 'version' | 'candidate' | 'local';
  promptVersionId: string | null;
  variantLabel: string;
  /**
   * The number of the prompt version behind this variant, so an alias label such
   * as `production` can be shown as "v1 (production)". `null` for an optimizer
   * candidate (no committed version) or a version that has since been deleted.
   */
  versionNumber: number | null;
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

/**
 * The commonest reason a cell's examples went unscored, with how many share it. The
 * reason is the example's `errorMessage` when its candidate call failed, otherwise the
 * judge's `reason` (a "judge call failed: …" marker, or why there was nothing to grade).
 */
export interface RunReportUnscoredReason {
  message: string;
  count: number;
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
  /**
   * Examples whose candidate call failed, so they produced no answer at all. They are
   * part of `unscoredCount`, and `avgScore` leaves them out (issue #576).
   */
  erroredCount: number;
  /** Why this cell's examples went unscored; null when every example scored (issue #570). */
  unscoredReason: RunReportUnscoredReason | null;
  deltaVsBaseline: RunReportDelta | null;
  /** Per-name aggregates of a local run's scores, in first-seen order; empty on a server-side cell. */
  namedScores: RunReportNamedScore[];
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
  /**
   * The judge that graded this run, as recorded on the run at start. Both
   * fields are null for runs created before the judge was recorded on the run;
   * `promptVersionId` is also null when the built-in judge graded it.
   */
  judge?: { model: string | null; promptVersionId: string | null };
  /** The commonest reason a result in this run has no score, counted over every cell; null when all scored. */
  unscoredReason: RunReportUnscoredReason | null;
}
