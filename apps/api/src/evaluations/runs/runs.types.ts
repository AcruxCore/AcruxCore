import { z } from 'zod';

/**
 * One frozen dataset example inside `ExperimentRun.exampleSnapshot`. Captured
 * at run-start time so a run's inputs stay stable even if the dataset changes
 * afterwards (design §"Data model").
 */
export interface RunSnapshotExample {
  exampleId: string;
  input: Record<string, unknown>;
  criteria: string | null;
  /** Prior-turn history frozen from the dataset example at run-start (FAQ Q19), or null. */
  history: import('../../gateway/providers/types').ChatMessage[] | null;
  /**
   * The example's structured reference answer (phase-5 FAQ Q46). Absent on runs
   * frozen before the column existed; null when the example has none.
   */
  expected?: unknown;
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

/**
 * Validated body for `POST /runs/:id/rejudge` (issue #639).
 *
 * `only_unscored` defaults to true because the common case is a judge outage:
 * re-grading only what has no score leaves every verdict that did land alone.
 * `false` re-grades every result that has an output, for a judge that graded
 * wrongly rather than not at all.
 */
export const RejudgeRunBodySchema = z
  .object({
    only_unscored: z.boolean().default(true),
  })
  .strict();
export type RejudgeRunDto = z.infer<typeof RejudgeRunBodySchema>;

/** What `RunsService.rejudgeRun` reports back. */
export interface RejudgeRunResult {
  runId: string;
  /** `running` when judge jobs were queued; the run's unchanged status when none were. */
  status: string;
  /** How many results were sent back to the judge. */
  rejudging: number;
}

/** Result-count summary returned alongside a run's status. */
export interface RunResultsSummary {
  total: number;
  succeeded: number;
  errored: number;
}

/**
 * Query params for `GET /runs` — the run-history list. All filters optional;
 * `page`/`limit` mirror the platform's list convention (`GET /traces`), and
 * snake_case names mirror the wire contract. `status` matches the
 * `experiment_run_status` Postgres enum exactly.
 */
export const RunListQuerySchema = z.object({
  status: z.enum(['queued', 'running', 'succeeded', 'failed']).optional(),
  dataset_id: z.string().uuid().optional(),
  prompt_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
/** Parsed query params for `GET /runs` (wire/snake_case shape, post-coercion). */
export type RunListQuery = z.infer<typeof RunListQuerySchema>;

/**
 * Internal (camelCase) filter shape passed from the service into the
 * repository. `page`/`limit` are always present; every other field narrows the
 * result set.
 */
export interface RunListFilters {
  status?: 'queued' | 'running' | 'succeeded' | 'failed';
  datasetId?: string;
  promptId?: string;
  page: number;
  limit: number;
}

/**
 * Result aggregates for one (run × prompt-variant) group of `eval_results`, as
 * produced by the history list's single grouped query. Grouped per variant
 * rather than per run so the caller can fold them two ways: summed for the
 * run's own totals, compared for its best-scoring variant.
 *
 * `scoreSum`/`scored` are carried raw rather than a pre-divided mean so a
 * multi-variant run's overall mean stays exact — averaging per-group means
 * would weight a 1-example variant like a 100-example one.
 */
export interface RunVariantAggregate {
  runId: string;
  variantLabel: string;
  /** Result rows in this group, errored ones included. */
  total: number;
  /** Rows that failed to produce output (`error_message IS NOT NULL`). */
  errored: number;
  /** Rows carrying a judge score. */
  scored: number;
  /** Sum of those scores (0–100 each); `0` when none are scored. */
  scoreSum: number;
  /** Rows the judge passed. */
  passed: number;
}

/** Who started a run. Null on the DTO for runs started by a team-scoped API key (no acting user). */
export interface RunListStarter {
  id: string;
  /** Display name, falling back to the email address when the user has not set one. */
  name: string;
  email: string;
}

/** Per-run result counts inside a {@link RunListItemDto}. */
export interface RunListResultCounts {
  total: number;
  succeeded: number;
  errored: number;
  /** Results carrying a judge score. Lower than `succeeded` when an example had no criterion. */
  scored: number;
}

/**
 * One row of the run-history list (`GET /runs`). Carries enough context to
 * recognise a run without opening it: what it evaluated, the shape of its
 * frozen grid, and how it scored.
 *
 * `kind` is derived from the frozen grid rather than stored — an optimize run
 * (E6) is an ordinary `experiment_runs` row distinguished only by containing
 * `variantKind: 'candidate'` cells.
 *
 * `avgScore`/`passRate`/`topVariantLabel` are `null` — never `0`/`''` — when a
 * run has no scored results yet, matching how the report reports an unscored
 * cell.
 */
export interface RunListItemDto {
  id: string;
  status: string;
  kind: import('./run-list.aggregate').RunKind;
  experimentId: string;
  experimentName: string | null;
  datasetId: string;
  datasetName: string;
  promptId: string | null;
  promptName: string | null;
  /** Distinct variant labels in the frozen grid. */
  variantCount: number;
  /** Distinct models in the frozen grid. */
  modelCount: number;
  /** Examples frozen into `exampleSnapshot` at run-start. */
  exampleCount: number;
  results: RunListResultCounts;
  /** Mean judge score across every scored result, 0–100, rounded to 1dp. */
  avgScore: number | null;
  /** Share of scored results that passed, 0–1, rounded to 3dp. */
  passRate: number | null;
  /** The highest-mean-score cell's variant label (e.g. `v3`, `candidate-A`). */
  topVariantLabel: string | null;
  startedBy: RunListStarter | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** `endedAt − startedAt` in ms; null while a run has not both started and finished. */
  durationMs: number | null;
}

/** Paginated envelope for `GET /runs`. */
export interface RunListResponse {
  data: RunListItemDto[];
  total: number;
  page: number;
  limit: number;
}

/** Response DTO for `GET /runs/:id`. */
export interface RunDetailDto {
  id: string;
  /** `local` for a run whose app and scorers ran in the caller's SDK (phase-5 FAQ Q46). */
  kind: import('./run-list.aggregate').RunKind;
  experimentId: string;
  /** The dataset the run graded; runs sharing it can be compared per example. */
  datasetId: string;
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
  /** Prior-turn history frozen at run-start (FAQ Q19), or null. */
  history: import('../../gateway/providers/types').ChatMessage[] | null;
  output: unknown;
  /**
   * Why this cell produced nothing, or null when it ran. Written by
   * `cellWorker`'s `'failed'` handler (via `RunsRepository.writeResultError`)
   * once a cell has exhausted its retries — an unregistered model, an
   * exhausted budget, a revoked credential, a provider outage.
   *
   * Carried on the DTO because it is the only account of what went wrong that
   * exists anywhere: `reason` below is the *judge's* reason and stays null
   * when there was no output to judge, so a failed cell used to arrive as an
   * entirely blank row (issue #504).
   */
  errorMessage: string | null;
  score: number | null;
  passed: boolean | null;
  reason: string | null;
  traceId: string | null;
  judgeTraceId: string | null;
  /** The example's structured reference answer (phase-5 FAQ Q46), or null. */
  expected: unknown;
  /** A local result's named scores, 0–100; empty on a server-side result. */
  scores: RunNamedScore[];
}

/** One named score on a local result (phase-5 FAQ Q46), as every read returns it. */
export interface RunNamedScore {
  name: string;
  /** 0–100, or null when the scorer raised. */
  score: number | null;
  passed: boolean | null;
  reason: string | null;
}

/** Response DTO for `GET /runs/:id/cells/:cellKey`. */
export interface RunCellDetailDto {
  cellKey: string;
  variantLabel: string;
  model: string;
  examples: RunCellExampleDto[];
}

/**
 * Query params for `GET /runs/:id/compare`. The base cell is in the run named by the
 * path; the target cell is in `target_run_id`, or the same run when it is omitted.
 */
export const RunCompareQuerySchema = z.object({
  base_cell: z.string({ required_error: '`base_cell` is required.' }).min(1, '`base_cell` is required.'),
  target_cell: z.string({ required_error: '`target_cell` is required.' }).min(1, '`target_cell` is required.'),
  target_run_id: z.string().uuid('`target_run_id` must be a UUID.').optional(),
  // A local run's named score to classify on, instead of each result's primary
  // score (phase-5 FAQ Q46). A side whose result lacks it reads as unscored.
  score: z.string().min(1).max(100).optional(),
});
export type RunCompareQuery = z.infer<typeof RunCompareQuerySchema>;

/**
 * How one example moved from the base cell to the target cell. Decided on pass/fail,
 * because the judge's 0–100 score moves a few points between runs on the same output;
 * `scoreDelta` is reported beside it but never decides the change.
 * `unscored` — one side has no pass/fail verdict (not judged, or the cell failed).
 * `missing` — the example has a result on only one side.
 */
export type RunCompareChange = 'improved' | 'regressed' | 'unchanged' | 'unscored' | 'missing';

/** One side of a compared example: what that cell produced and how it was judged. */
export interface RunCompareSide {
  output: unknown;
  errorMessage: string | null;
  score: number | null;
  passed: boolean | null;
  reason: string | null;
  traceId: string | null;
  /** Every named score of a local result; empty on a server-side result. */
  scores: RunNamedScore[];
}

/** One dataset example, with both cells' results side by side. */
export interface RunCompareExampleDto {
  exampleId: string;
  input: Record<string, unknown>;
  criteria: string | null;
  /** The example's structured reference answer, or null. */
  expected: unknown;
  base: RunCompareSide | null;
  target: RunCompareSide | null;
  /** `target.score - base.score`, or null when either score is missing. */
  scoreDelta: number | null;
  change: RunCompareChange;
}

/** Identifies one compared cell. */
export interface RunCompareCellRef {
  runId: string;
  cellKey: string;
  variantLabel: string;
  model: string;
}

/** Response for `GET /runs/:id/compare`. */
export interface RunCompareDto {
  base: RunCompareCellRef;
  target: RunCompareCellRef;
  /** The named score the examples were classified on, or null for the primary score. */
  score: string | null;
  /** Every score name either side carries, in first-seen order, so a client can offer a picker. */
  scoreNames: string[];
  /** How many examples fall under each change; the five always add up to `examples.length`. */
  counts: Record<RunCompareChange, number>;
  examples: RunCompareExampleDto[];
}

