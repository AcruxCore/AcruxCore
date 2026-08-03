/**
 * One frozen dataset example inside `ExperimentRun.exampleSnapshot`. Captured
 * at run-start time so a run's inputs stay stable even if the dataset changes
 * afterwards (design §"Data model").
 */
export interface RunSnapshotExample {
  exampleId: string;
  input: Record<string, unknown>;
  criteria: string | null;
}

/**
 * One resolved (prompt-variant × model) cell inside `ExperimentRun.grid`.
 * `variantKind` is `'version'` for an explicit version or the
 * production-baseline cell, and `'candidate'` for an optimizer-drafted
 * rewrite (E6) — `variantLabel` further distinguishes an explicit version
 * cell (`v<N>`) from the production-baseline cell (`'production'`) or a
 * candidate cell (`candidate-A`, `candidate-B`, ...). Exactly one of
 * `promptVersionId`/`promptCandidateId` is set, mirroring `CellJobData`
 * (`../queue/queues.ts`): a `'version'` cell carries `promptVersionId`; a
 * `'candidate'` cell carries `promptCandidateId` instead, since an
 * optimizer-drafted rewrite is not (yet) a real `prompt_versions` row.
 */
export interface RunGridCell {
  cellKey: string;
  variantKind: string;
  promptVersionId?: string;
  promptCandidateId?: string;
  variantLabel: string;
  model: string;
  /**
   * Whether this cell is the production baseline the report measures every
   * other cell's regression delta against. Frozen into the grid at run-start
   * (`RunsService.resolveGrid` / the E6 optimizer) rather than re-derived from
   * `variantLabel === 'production'` at read time — because a run can name the
   * production version *explicitly* in `version_ids`, in which case its cell is
   * labeled `v<N>` (not `'production'`) yet is still the baseline.
   */
  isProductionBaseline: boolean;
}

/** Response DTO for `POST /experiments/:id/runs`. */
export interface StartRunResult {
  runId: string;
  status: string;
}

/** Result-count summary returned alongside a run's status. */
export interface RunResultsSummary {
  total: number;
  succeeded: number;
  errored: number;
}

/** Response DTO for `GET /runs/:id`. */
export interface RunDetailDto {
  id: string;
  experimentId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  createdAt: string;
  grid: RunGridCell[];
  exampleCount: number;
  results: RunResultsSummary;
}

/**
 * One dataset example's row inside a cell drill-down response (`GET
 * /runs/:id/cells/:cellKey`): the produced output, judge verdict, and the
 * two traces (generation + judge call) behind it.
 */
export interface RunCellExampleDto {
  exampleId: string;
  input: Record<string, unknown>;
  criteria: string | null;
  output: unknown;
  score: number | null;
  passed: boolean | null;
  reason: string | null;
  traceId: string | null;
  judgeTraceId: string | null;
}

/** Response DTO for `GET /runs/:id/cells/:cellKey`. */
export interface RunCellDetailDto {
  cellKey: string;
  variantLabel: string;
  model: string;
  examples: RunCellExampleDto[];
}
