import type { TraceOptions } from './types';

// ── Dataset types ──

export interface DatasetDto {
  id: string;
  teamId: string;
  name: string;
  overallFeedback: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  exampleCount: number;
}

export interface DatasetExampleDto {
  id: string;
  datasetId: string;
  input: Record<string, unknown>;
  criteria: string | null;
  history: EvalChatMessage[] | null;
  /**
   * The example's structured reference answer, for code scorers in a local experiment
   * (`experiments.runLocal`). Any JSON; `null` when none was given. The LLM judge does
   * not read it — it grades against `criteria`.
   */
  expected: unknown;
  sourceTraceId: string | null;
  sourceFeedbackId: string | null;
  sourcePromptVersionId: string | null;
  createdAt: string;
}

export interface EvalChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface DatasetWithExamples extends DatasetDto {
  examples: DatasetExampleDto[];
}

export interface CreateDatasetParams {
  name: string;
  overallFeedback?: string;
}

export interface BuildFromFeedbackParams {
  name: string;
  feedbackIds: string[];
  overallFeedback?: string;
}

export interface BuildFromFeedbackResult {
  id: string;
  name: string;
  overallFeedback: string | null;
  exampleCount: number;
  skipped: Array<{ feedbackId: string; reason: string }>;
}

export interface UpdateDatasetParams {
  name?: string;
  overallFeedback?: string | null;
}

export interface AddExampleParams {
  input: Record<string, unknown>;
  criteria?: string;
  history?: EvalChatMessage[];
  /**
   * A structured reference answer (any JSON) that local-experiment scorers receive as
   * `expected`. Omit, or pass `null`, for none. Capped by the server at the same size
   * as `input`.
   */
  expected?: unknown;
}

/** Result of `datasets.addExamples`: rows written and the dataset's total afterwards. */
export interface AddExamplesResult {
  added: number;
  exampleCount: number;
}

// ── Experiment types ──

export interface ExperimentDto {
  id: string;
  teamId: string;
  datasetId: string;
  promptId: string | null;
  name: string | null;
  config: {
    versionIds: string[];
    models: string[];
    alias?: string;
    /** The model that grades this experiment's runs. Absent on experiments created before judges were chosen per experiment; those cannot be run. */
    judgeModel?: string;
    /** The custom judge prompt, when one was chosen. Absent for the built-in judge. */
    judgePromptId?: string;
  };
  createdBy: string | null;
  createdAt: string;
  runs: ExperimentRunDto[];
  promptMismatchWarning?: {
    mismatchedPrompts: Array<{ promptId: string; name: string; exampleCount: number }>;
  };
}

export interface ExperimentRunDto {
  id: string;
  experimentId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  createdAt: string;
  /** The judge model that graded this run. Null for runs created before it was recorded on the run. */
  judgeModel: string | null;
  /** The custom judge prompt version frozen at run start. Null for the built-in judge. */
  judgePromptVersionId: string | null;
}

export interface CreateExperimentParams {
  datasetId: string;
  promptId?: string;
  name?: string;
  versionIds: string[];
  models: string[];
  alias?: string;
  /** The model that grades every result: a model registered under Gateway → Models. Required; there is no server-side default. */
  judgeModel: string;
  /**
   * A prompt of yours that grades instead of the built-in judge. Each run uses its
   * `production` version (else its latest). Omit for the built-in judge.
   */
  judgePromptId?: string;
}

// ── Run types ──

export interface StartRunResult {
  runId: string;
  status: string;
}

export interface ListRunsParams {
  status?: string;
  datasetId?: string;
  promptId?: string;
  page?: number;
  limit?: number;
}

export interface RunListItemDto {
  id: string;
  status: string;
  kind: RunKind;
  experimentId: string;
  experimentName: string | null;
  datasetId: string;
  datasetName: string;
  promptId: string | null;
  promptName: string | null;
  variantCount: number;
  modelCount: number;
  exampleCount: number;
  results: { total: number; succeeded: number; errored: number; scored: number };
  avgScore: number | null;
  passRate: number | null;
  topVariantLabel: string | null;
  startedBy: { id: string; name: string; email: string } | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
}

/**
 * What produced a run. `local` is a run whose app and scorers ran in your own process
 * through `experiments.runLocal`; servers older than local runs never send it.
 */
export type RunKind = 'evaluation' | 'optimize' | 'local';

export interface RunListResponse {
  data: RunListItemDto[];
  total: number;
  page: number;
  limit: number;
}

export interface RunGridCell {
  cellKey: string;
  variantKind: string;
  promptVersionId?: string;
  promptCandidateId?: string;
  variantLabel: string;
  model: string;
  isProductionBaseline: boolean;
}

export interface RunDetailDto {
  id: string;
  /** What produced the run. Absent from servers older than this field. */
  kind?: RunKind;
  experimentId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  createdAt: string;
  grid: RunGridCell[];
  exampleCount: number;
  results: { total: number; succeeded: number; errored: number };
}

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
  deltaVsBaseline: {
    score: number | null;
    passRate: number | null;
    label: 'improved' | 'regressed' | 'flat' | 'unknown';
  } | null;
  /**
   * Per-name aggregates of a local run's scores, in first-seen order. Empty on a
   * server-side cell (it has one judge score), absent from servers older than local runs.
   */
  namedScores?: RunReportNamedScore[];
}

/** One named score's aggregate over a local run's cell. Scores are 0–100, like the judge's. */
export interface RunReportNamedScore {
  name: string;
  /** Mean 0–100 over the results that carry this score with a value; null when none do. */
  avgScore: number | null;
  /** Share of those results that passed, 0–1; null when none are scored. */
  passRate: number | null;
  scoredCount: number;
}

export interface RunReport {
  runId: string;
  status: string;
  models: string[];
  variants: Array<{
    variantKind: 'version' | 'candidate' | 'local';
    promptVersionId: string | null;
    variantLabel: string;
    /** The version behind the label, e.g. 1 for a `production` baseline. Null for a candidate. */
    versionNumber?: number | null;
    isProductionBaseline: boolean;
  }>;
  cells: RunReportCell[];
  leaderboard: string[];
  winner: {
    cellKey: string;
    variantLabel: string;
    model: string;
    avgScore: number;
  } | null;
  /** The judge that graded this run. Absent from servers older than this field. */
  judge?: { model: string | null; promptVersionId: string | null };
}

export interface RunCellExampleDto {
  exampleId: string;
  input: Record<string, unknown>;
  criteria: string | null;
  history: EvalChatMessage[] | null;
  output: unknown;
  /**
   * Why this cell produced no output, when it produced none. `null` on a cell that
   * ran — so a failed cell is a row with a reason rather than a blank one.
   */
  errorMessage: string | null;
  score: number | null;
  passed: boolean | null;
  reason: string | null;
  traceId: string | null;
  judgeTraceId: string | null;
  /** The example's structured reference answer, or null. Absent from older servers. */
  expected?: unknown;
  /** A local result's named scores, 0–100. Empty on a server-side result; absent from older servers. */
  scores?: RunNamedScore[];
}

/** One named score on a local run's result, as the API returns it. 0–100, like the judge's score. */
export interface RunNamedScore {
  name: string;
  /** 0–100, or null when the scorer threw or returned something unusable. */
  score: number | null;
  passed: boolean | null;
  reason: string | null;
}

export interface RunCellDetailDto {
  cellKey: string;
  variantLabel: string;
  model: string;
  examples: RunCellExampleDto[];
}

export interface CandidateDetail {
  id: string;
  promptId: string;
  messages: Array<{ role: string; content: string }>;
  rationale: string | null;
  label: string;
  createdAt: string;
}

export interface PromoteCandidateParams {
  promptCandidateId: string;
  alias?: string;
}

export interface PromoteResult {
  version: {
    id: string;
    promptId: string;
    versionNumber: number;
    messages: Array<{ role: string; content: string }>;
    variables: string[];
    model: string | null;
    createdBy: string;
    createdAt: string;
  };
  alias: {
    id: string;
    alias: string;
    versionId: string;
    versionNumber: number;
    updatedAt: string;
  };
}

// ── Optimize types ──

export interface StartOptimizeParams {
  datasetId: string;
  models: string[];
  draftCount?: number;
  alias?: string;
  /** The model that grades every candidate and baseline result: a model registered under Gateway → Models. Required; there is no server-side default. */
  judgeModel: string;
}

export interface StartOptimizeResult {
  runId: string;
  status: string;
  promptMismatchWarning?: {
    mismatchedPrompts: Array<{ promptId: string; name: string; exampleCount: number }>;
  };
}

// ── Local experiment types (experiments.runLocal) ──

/** One frozen dataset example, as a local run hands it to the task and the scorers. */
export interface LocalExample {
  id: string;
  input: Record<string, unknown>;
  /** The example's free-text rubric, or null. */
  criteria: string | null;
  /** The example's structured reference answer, or null when it has none. */
  expected: unknown;
  /**
   * The earlier turns of an example built from a multi-turn session, or null. A
   * server-side run replays them before the input; pass them to your app to do the same.
   */
  history: EvalChatMessage[] | null;
}

/**
 * The second argument a local-run task receives.
 *
 * `traceId` is minted by the SDK for this example before the task starts, and the SDK
 * records one `chain` span under it when the task ends. Pass `trace` as the `trace`
 * option of `gateway.chat` / `stream` / `runToolLoop` so the app's own model calls land
 * in that same trace; without it they get traces of their own and the result's trace
 * shows only the SDK's span.
 */
export interface LocalTaskContext extends LocalExample {
  traceId: string;
  /** `{ traceId, name }`, ready to pass as a gateway call's `trace` option. */
  trace: TraceOptions;
}

/**
 * The app code under test: called once per example. May be sync or async. Whatever it
 * returns is the example's output; anything it throws becomes an errored result (no
 * scorers run) and does not stop the run.
 */
export type LocalTask<O> = (input: Record<string, unknown>, ctx: LocalTaskContext) => O | Promise<O>;

/**
 * One score a scorer returns. `score` is 0–1 (like Langfuse and LangSmith; the SDK
 * sends 0–100 to the API), or `null` for "could not score". `passed` defaults to
 * `score >= 0.5`. `name` defaults to the scorer function's name.
 */
export interface Score {
  name?: string;
  score: number | null;
  passed?: boolean | null;
  reason?: string | null;
}

/** What a scorer may return: pass/fail, a 0–1 number, one {@link Score}, or several. */
export type ScorerReturn = boolean | number | Score | Score[];

/** The single object every scorer receives. */
export interface ScorerArgs<O> {
  output: O;
  expected: unknown;
  input: Record<string, unknown>;
  criteria: string | null;
  example: LocalExample;
}

/**
 * Grades one output in your own code. Called only when the task succeeded. A scorer
 * that throws records a null score whose reason is the error — it never stops the run.
 * An out-of-range number is recorded the same way, so a bug in a scorer shows up as a
 * reason in the dashboard rather than as a silently wrong score.
 */
export type Scorer<O> = (args: ScorerArgs<O>) => ScorerReturn | Promise<ScorerReturn>;

/** Options for `experiments.runLocal`. */
export interface RunLocalOptions<O> {
  /** The app code to run once per example. */
  task: LocalTask<O>;
  /** Code scorers. Omit to record outputs only (the run then has no scores). */
  scorers?: Scorer<O>[];
  /** Required. Labels the run (its one cell) and names the experiment, e.g. `"v2"`. Must not contain `|`. */
  name: string;
  /** Free-text model label shown on the run, default `"local"`. Not checked against the gateway. */
  model?: string;
  /**
   * The score copied into each result's headline score, pass rate and the run list.
   * Omitted, each result's first score is used — the first scorer's, since scores are
   * kept in scorer order.
   */
  primaryScore?: string;
  /** Free JSON stored on the experiment, e.g. `{ git_sha }`. */
  metadata?: Record<string, unknown>;
  /** How many examples run at once. Default 4. Must be a positive integer. */
  concurrency?: number;
}

/** One score as `runLocal` reports it back: always named, 0–1. */
export interface LocalScore {
  name: string;
  /** 0–1, or null when the scorer threw or returned something out of range. */
  score: number | null;
  passed: boolean | null;
  reason: string | null;
}

/** One example's outcome in a local run. */
export interface LocalRunItem<O> {
  exampleId: string;
  input: Record<string, unknown>;
  expected: unknown;
  /** What the task returned, unchanged. Null when the task threw. */
  output: O | null;
  /** `"<ErrorName>: <message>"` when the task threw, else null. */
  error: string | null;
  /** The example's trace, or null when the SDK could not record its span. */
  traceId: string | null;
  /** Empty when the task threw. */
  scores: LocalScore[];
}

/** One score name's totals over the run. */
export interface LocalScoreSummary {
  /** Mean 0–1 over the results with a non-null value; null when none have one. */
  mean: number | null;
  /** Share of the scored results that passed, 0–1; null when none are scored. */
  passRate: number | null;
  /** How many results carry this score with a non-null value. */
  scored: number;
}

/** What `experiments.runLocal` resolves to once the run is finished. */
export interface LocalRunResult<O> {
  runId: string;
  experimentId: string;
  /** The run's page in the dashboard, or null when the server has no `APP_URL` set. */
  url: string | null;
  /** The run's final status: `succeeded`, or `failed` when every result errored. */
  status: string;
  items: LocalRunItem<O>[];
  /** Keyed by score name. */
  summary: Record<string, LocalScoreSummary>;
}
