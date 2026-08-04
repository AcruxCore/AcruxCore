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
  kind: 'evaluation' | 'optimize';
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
  /** Prior-turn history frozen at run-start (FAQ Q19), or null. */
  history: import('../../gateway/providers/types').ChatMessage[] | null;
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
