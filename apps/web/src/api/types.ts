/**
 * Frontend copies of the API's response/request DTOs.
 *
 * Hand-maintained to match `apps/api/src/**\/*.types.ts`. All timestamps are
 * strings (JSON-serialized `Date`). If a second consumer ever needs these,
 * promote to a shared `packages/types` (see the design spec, §12).
 */

export type Role = 'owner' | 'admin' | 'editor' | 'viewer';
/** Roles that are grantable via invite/role-edit (owner is signup-only). */
export type GrantableRole = 'admin' | 'editor' | 'viewer';

export interface User {
  id: string;
  email: string;
  displayName: string | null;
}

export interface Team {
  id: string;
  name: string;
}

export interface Me {
  user: User;
  team: Team;
  role: Role;
}

/** One team the current user belongs to (GET /auth/teams). */
export interface TeamMembership {
  id: string;
  name: string;
  role: Role;
}

export interface AuthResponse {
  user: User;
  team: Team;
}

export type MessageRole = 'system' | 'user' | 'assistant';
export interface Message {
  role: MessageRole;
  content: string;
}

// ── Gateway: tool-calling chat messages (TC5) ───────────────────────────────
/** Roles accepted by the gateway's tool-calling-capable chat endpoint. */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** A model-emitted tool call (arguments is a JSON-encoded string, per OpenAI). */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** OpenAI-shaped tool (function) definition sent in `CompletionBody.tools`. */
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

/**
 * A chat message for the gateway's tool-calling loop. Distinct from {@link Message}
 * (which backs prompt-template editing, where `content` is always a non-null
 * string) because assistant tool-call messages may carry `content: null` and
 * `tool` messages must echo back a `tool_call_id`.
 */
export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

// ── Prompts ───────────────────────────────────────────────────────────────
export interface Prompt {
  id: string;
  name: string;
  description: string | null;
  teamId: string;
  createdBy: string;
  createdAt: string;
}

export interface PromptListItem {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
}

// ── Versions ──────────────────────────────────────────────────────────────
export interface VersionListItem {
  id: string;
  versionNumber: number;
  variables: string[];
  createdBy: string;
  createdAt: string;
  /** Bound default model's current publicName, or null if unbound/deleted (#12). */
  model: string | null;
}

export interface VersionDetail {
  id: string;
  promptId: string;
  versionNumber: number;
  messages: Message[];
  variables: string[];
  createdBy: string;
  createdAt: string;
  /** Bound default model's current publicName, or null if unbound/deleted (#12). */
  model: string | null;
}

/** Body for POST /prompts/:id/versions. */
export interface CommitVersionInput {
  promptId: string;
  messages: Message[];
  /** Optional default model publicName to bind on this version (#12); omitted = unbound. */
  model?: string | null;
}

/** GET /prompt-versions/:versionId — resolves a version UUID to its prompt + raw messages. */
export interface VersionByIdResponse {
  promptId: string;
  promptName: string;
  versionNumber: number;
  messages: { role: MessageRole; content: string }[];
  variables: string[];
  /** OpenAI-shaped tool definitions attached to this version (TC3 FAQ Q4). */
  tools: ToolDefinition[];
  /** Bound default model's current publicName, or null if unbound/deleted (#12). */
  model: string | null;
}

// ── Aliases ───────────────────────────────────────────────────────────────
export interface AliasDetail {
  id: string;
  alias: string;
  versionId: string;
  versionNumber: number;
  updatedAt: string;
}

// ── Diff ──────────────────────────────────────────────────────────────────
export interface DiffResponse {
  diff: string;
  fromVersion: number;
  toVersion: number;
}

// ── Audit ─────────────────────────────────────────────────────────────────
export interface AuditEntry {
  id: string;
  event: string;
  actor: { id: string; email: string };
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// ── API keys (personal + team share these shapes) ──────────────────────────
export interface ApiKeyListItem {
  id: string;
  name: string | null;
  lastFour: string;
  createdAt: string;
}

export interface ApiKeyCreated {
  id: string;
  key: string;
  name: string | null;
  createdAt: string;
}

// ── Team members & invites ─────────────────────────────────────────────────
export interface MemberListItem {
  userId: string;
  email: string;
  role: Role;
  joinedAt: string;
}

export interface InviteListItem {
  id: string;
  token: string;
  role: GrantableRole;
  invitedBy: string;
  /** Address the invite was emailed to, or null for a copy-link invite. */
  email: string | null;
  expiresAt: string;
  createdAt: string;
}

// ── Export (single version) ─────────────────────────────────────────────────
export interface PromptExport {
  name: string;
  description: string | null;
  messages: Message[];
  variables: string[];
}

// ── Gateway: provider connections (BYOK) ────────────────────────────────────
export type ProviderKind = 'openai' | 'anthropic' | 'gemini' | 'openai_compatible';

/**
 * Optional routing hints stored inside a connection's `config` JSONB (G5).
 * `models` is an allow-list restricting which models this connection serves.
 */
export interface ConnectionConfig {
  base_url?: string;
  priority?: number;
  weight?: number;
  models?: string[];
  [k: string]: unknown;
}

/** A provider connection as returned by the API — the secret is never included. */
export interface ProviderConnection {
  id: string;
  provider: ProviderKind;
  label: string;
  keyLastFour: string;
  config: ConnectionConfig;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConnectionInput {
  provider: ProviderKind;
  label: string;
  apiKey: string;
  config?: ConnectionConfig;
}

export interface UpdateConnectionInput {
  label?: string;
  apiKey?: string;
  config?: ConnectionConfig;
}

// ── Gateway: model registry ─────────────────────────────────────────────────
/** A registered model (deployment): public name → upstream model → credential + price. */
export interface GatewayModel {
  id: string;
  publicName: string;
  upstreamModel: string;
  credentialId: string;
  credentialLabel: string;
  provider: string;
  inputPricePerM: number | null;
  outputPricePerM: number | null;
  fallbacks: { id: string; publicName: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateModelInput {
  publicName: string;
  upstreamModel: string;
  credentialId: string;
  inputPricePerM?: number | null;
  outputPricePerM?: number | null;
  fallbackModelIds?: string[];
}

export interface UpdateModelInput {
  publicName?: string;
  upstreamModel?: string;
  credentialId?: string;
  inputPricePerM?: number | null;
  outputPricePerM?: number | null;
  fallbackModelIds?: string[];
}

/** Result of testing a model — a diagnostic ping. */
export interface ModelTestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

// ── Gateway: virtual keys ───────────────────────────────────────────────────
export interface VirtualKeyListItem {
  id: string;
  name: string;
  keyLastFour: string;
  allowedModels: string[] | null;
  allowedProviders: string[] | null;
  maxRpm: number | null;
  maxTpm: number | null;
  cacheTtlSeconds: number | null;
  createdAt: string;
  revokedAt: string | null;
}

/** Create response — the plaintext `key` (`agh_sk_…`) is returned exactly once. */
export interface VirtualKeyCreated extends Omit<VirtualKeyListItem, 'revokedAt'> {
  key: string;
}

export interface CreateVirtualKeyInput {
  name: string;
  allowedModels?: string[] | null;
  allowedProviders?: string[] | null;
  maxRpm?: number | null;
  maxTpm?: number | null;
  cacheTtlSeconds?: number | null;
}

export type UpdateVirtualKeyInput = Partial<CreateVirtualKeyInput>;

// ── Gateway: budgets ────────────────────────────────────────────────────────
export type BudgetPeriod = 'day' | 'week' | 'month' | 'total';

export interface Budget {
  id: string;
  virtualKeyId: string | null;
  period: BudgetPeriod;
  limitUsd: number;
  spendUsd: number;
  resetsAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBudgetInput {
  virtualKeyId?: string | null;
  period: BudgetPeriod;
  limitUsd: number;
}

export interface UpdateBudgetInput {
  period?: BudgetPeriod;
  limitUsd?: number;
}

// ── Gateway: usage & request log (read-only analytics) ──────────────────────
export type UsageGroupBy = 'day' | 'model' | 'virtual_key' | 'provider';

export interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  cacheHitRate: number;
  errorRate: number;
}

export interface UsageBucket {
  key: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface UsageResponse {
  from: string;
  to: string;
  groupBy: UsageGroupBy;
  totals: UsageTotals;
  buckets: UsageBucket[];
}

export type RequestStatus = 'success' | 'error' | 'cache_hit';

export interface GatewayRequestItem {
  id: string;
  createdAt: string;
  virtualKeyId: string | null;
  provider: string | null;
  requestedModel: string;
  resolvedModel: string | null;
  status: RequestStatus;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  latencyMs: number | null;
  cacheHit: boolean;
  promptVersionId: string | null;
  errorCode: string | null;
}

// ── Gateway: chat completions (OpenAI-compatible) ───────────────────────────
export interface ChatCompletionChoice {
  index: number;
  message: { role: string; content: string | null; tool_calls?: ToolCall[] };
  finish_reason: string | null;
}

export interface ChatCompletion {
  id: string;
  model: string;
  object: string;
  created: number;
  choices: ChatCompletionChoice[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** Gateway telemetry parsed from the `x-gateway-*` response headers. */
export interface GatewayMeta {
  requestId: string | null;
  provider: string | null;
  model: string | null;
  costUsd: string | null;
  cache: string | null;
  rateLimitRemaining: string | null;
}

// ── Observability / Tracing (T7) ────────────────────────────────────────────
export type SpanKind = 'llm' | 'tool' | 'retrieval' | 'embedding' | 'agent' | 'chain' | 'other';
export type SpanStatus = 'ok' | 'error' | 'unset';

/** Optional captured message bodies for a span; present only when capture is on. */
export interface SpanPayload {
  input?: unknown;
  output?: unknown;
  /** Raw prompt variables for a prompt-ref call, if the span captured any. */
  variables?: unknown;
}

/** A span as returned already-nested by GET /traces/:id (roots have parentSpanId === null). */
export interface Span {
  spanId: string;
  parentSpanId: string | null;
  kind: SpanKind;
  name: string;
  status: SpanStatus;
  startedAt: string;
  endedAt: string | null;
  latencyMs: number | null;
  model: string | null;
  provider: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  promptVersionId: string | null;
  gatewayRequestId: string | null;
  errorMessage: string | null;
  attributes: Record<string, unknown>;
  tags: string[];
  metadata: Record<string, unknown>;
  payload?: SpanPayload;
  children: Span[];
}

/** A trace row for the list table (GET /traces) and session-detail table (GET /sessions/:id). */
export interface TraceListItem {
  id: string;
  name: string | null;
  sessionId?: string | null;
  status: SpanStatus;
  startedAt: string;
  endedAt: string | null;
  spanCount: number;
  totalCostUsd: number | null;
  totalTokens: number;
  durationMs?: number | null;
  tags: string[];
}

/** The trace summary object inside GET /traces/:id (no durationMs; compute from started/ended). */
export interface TraceSummary {
  id: string;
  name: string | null;
  sessionId: string | null;
  status: SpanStatus;
  startedAt: string;
  endedAt: string | null;
  spanCount: number;
  totalCostUsd: number | null;
  totalTokens: number;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface Feedback {
  id: string;
  traceId: string;
  spanId: string | null;
  rating: number | null;
  label: string | null;
  comment: string | null;
  source: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One online-eval rule score attached to a trace (mirrors the backend's
 * `EvalScoreDto`). `score`/`passed`/`reason`/`judgeTraceId` are all `null`
 * when the rule matched a span but payload capture was off for the team, so
 * the judge was never called.
 */
export interface EvalScoreDto {
  id: string;
  ruleId: string;
  ruleName: string;
  score: number | null;
  passed: boolean | null;
  reason: string | null;
  judgeTraceId: string | null;
  createdAt: string;
}

export interface TraceDetail {
  trace: TraceSummary;
  spans: Span[];
  feedback: Feedback[];
  evalScores: EvalScoreDto[];
}

/** Frontend filter shape; the URL is the source of truth and hooks map these to snake_case query params. */
export interface TraceFilters {
  from?: string;
  to?: string;
  status?: SpanStatus;
  model?: string;
  sessionId?: string;
  promptVersionId?: string;
  minLatencyMs?: number;
  minCostUsd?: number;
  minTokens?: number;
  q?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  page?: number;
  limit?: number;
}

/** Response for GET /traces/facets: distinct tags + metadata keys for the team. */
export interface TraceFacets {
  tags: string[];
  metadataKeys: string[];
  /** Distinct resolved `llm` span models seen for the team — NOT `GatewayModel.publicName`. */
  models: string[];
}

export interface SessionSummary {
  sessionId: string;
  traceCount: number;
  totalCostUsd: number | null;
  totalTokens: number;
  firstAt: string;
  lastAt: string;
}

export interface SessionDetail {
  session: SessionSummary;
  traces: TraceListItem[];
}

export interface SessionsParams {
  from?: string;
  to?: string;
  q?: string;
  page?: number;
  limit?: number;
}

export type AnalyticsGroupBy = 'day' | 'model' | 'session' | 'prompt_version';

/** Latency percentiles in ms; null when the bucket/range has no timed spans. */
export interface LatencyPercentiles {
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface AnalyticsTotals {
  requests: number;
  errorRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: LatencyPercentiles;
}

/** One grouped bucket (a day, model, session id, or prompt-version id) — same shape as the range totals, plus `key`. */
export interface AnalyticsBucket extends AnalyticsTotals {
  key: string;
}

export interface TraceAnalytics {
  from: string;
  to: string;
  groupBy: AnalyticsGroupBy;
  totals: AnalyticsTotals;
  buckets: AnalyticsBucket[];
}

export interface AnalyticsParams {
  from?: string;
  to?: string;
  groupBy?: AnalyticsGroupBy;
  kind?: SpanKind;
  model?: string;
}

export interface PostFeedbackInput {
  rating?: number;
  label?: string;
  comment?: string;
  spanId?: string;
  source?: string;
}

/**
 * Body for PATCH /traces/:id/feedback/:feedbackId. A field set to `null` clears
 * it; a field omitted leaves it unchanged; `undefined` and omission behave the
 * same over JSON, so use `null` explicitly to clear.
 */
export interface PatchFeedbackInput {
  rating?: number | null;
  label?: string | null;
  comment?: string | null;
}

// ── Evaluations: datasets (E2) ──────────────────────────────────────────────
/** A dataset row (GET /datasets list item, and the shape returned by create/update). */
export interface Dataset {
  id: string;
  teamId: string;
  name: string;
  overallFeedback: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  exampleCount: number;
}

/** One example inside a dataset — the variable bag + rubric a candidate is judged against. */
export interface DatasetExample {
  id: string;
  datasetId: string;
  input: Record<string, unknown>;
  criteria: string | null;
  /** Prior-turn conversation reconstructed from the source session (FAQ Q19), or null. */
  history: ChatMessage[] | null;
  sourceTraceId: string | null;
  sourceFeedbackId: string | null;
  sourcePromptVersionId: string | null;
  createdAt: string;
}

/** One prompt whose dataset examples don't match the run's target prompt, and how many. */
export interface MismatchedPromptInfo {
  promptId: string;
  name: string;
  exampleCount: number;
}

/** Informational (non-blocking) warning: the dataset's examples don't all match the run's target prompt. */
export interface PromptMismatchWarning {
  mismatchedPrompts: MismatchedPromptInfo[];
}

/** GET /datasets/:id — a `Dataset` plus its full example list (the list endpoint omits `examples`). */
export interface DatasetDetail extends Dataset {
  examples: DatasetExample[];
}

/** GET /datasets — no pagination fields observed; the full team list comes back in `data`. */
export interface DatasetListResponse {
  data: Dataset[];
}

export interface CreateDatasetInput {
  name: string;
  overall_feedback?: string;
}

/** PATCH /datasets/:id — all fields optional; `overall_feedback: null` explicitly clears it. */
export interface UpdateDatasetInput {
  name?: string;
  overall_feedback?: string | null;
}

/**
 * POST /datasets/from-feedback response. NOTE the intentional casing quirk
 * (documented in docs/api/datasets.md and the phase-5 FAQ): this endpoint
 * returns snake_case `overall_feedback`/`example_count`, unlike every other
 * dataset endpoint (`GET /datasets`, `GET /datasets/:id`, `PATCH /datasets/:id`)
 * which return camelCase `overallFeedback`/`exampleCount`. Not a typo — keep
 * this type's field names exactly as the wire returns them.
 */
export interface CreateDatasetFromFeedbackResult {
  id: string;
  name: string;
  overall_feedback: string | null;
  example_count: number;
  skipped: { feedbackId: string; reason: string }[];
}

export interface CreateDatasetFromFeedbackInput {
  name: string;
  overall_feedback?: string;
  feedback_ids: string[];
}

// ── Evaluations: experiments & runs (E3) ────────────────────────────────────
export interface CreateExperimentInput {
  dataset_id: string;
  prompt_id?: string;
  name?: string;
  version_ids: string[];
  models: string[];
  alias?: string;
}

/** Resolved (prompt-version × model) sweep persisted on the experiment. */
export interface ExperimentConfig {
  versionIds: string[];
  models: string[];
}

/** A run summary as nested inside an `Experiment` (no grid/results — see `Run` for that). */
export interface ExperimentRunSummary {
  id: string;
  experimentId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  createdAt: string;
}

/** An experiment, with its runs (newest first) — populated on list, get, and create alike. */
export interface Experiment {
  id: string;
  teamId: string;
  datasetId: string;
  promptId: string | null;
  name: string | null;
  config: ExperimentConfig;
  createdBy: string | null;
  createdAt: string;
  runs: ExperimentRunSummary[];
  promptMismatchWarning?: PromptMismatchWarning;
}

export interface ExperimentListResponse {
  data: Experiment[];
}

/**
 * Response for both `POST /experiments/:id/runs` and `POST
 * /prompts/:promptId/optimize` — both endpoints enqueue a run and return
 * immediately. The wire shape is snake_case `run_id` (verified via curl and
 * the controller's manual `res.json({ run_id, status })`), unlike the
 * `RunDetailDto`'s camelCase fields returned by `GET /runs/:id`.
 */
export interface StartRunResponse {
  run_id: string;
  status: string;
  prompt_mismatch_warning?: {
    mismatched_prompts: Array<{ prompt_id: string; name: string; example_count: number }>;
  };
}

/** One resolved (prompt-variant × model) cell inside a run's grid. */
export interface RunGridCell {
  cellKey: string;
  variantKind: 'version' | 'candidate';
  promptVersionId?: string;
  promptCandidateId?: string;
  variantLabel: string;
  model: string;
}

export interface RunResultsSummary {
  total: number;
  succeeded: number;
  errored: number;
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/** GET /runs/:id — the full run detail, including its resolved grid and result counts. */
export interface Run {
  id: string;
  experimentId: string;
  status: RunStatus;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  createdAt: string;
  grid: RunGridCell[];
  exampleCount: number;
  results: RunResultsSummary;
}

/** Whether a run swept explicit prompt versions or optimizer-drafted candidates. */
export type RunKind = 'evaluation' | 'optimize';

/** Per-run result counts on a run-history row. `scored` ≤ `succeeded` — an example without criteria is never judged. */
export interface RunListResultCounts {
  total: number;
  succeeded: number;
  errored: number;
  scored: number;
}

/** Who started a run. Null for a run started by a team-scoped API key. */
export interface RunListStarter {
  id: string;
  /** Display name, falling back to the email address. */
  name: string;
  email: string;
}

/**
 * One row of `GET /runs` — the run-history list. `avgScore`/`passRate`/
 * `topVariantLabel` are null (never `0`) until the run has a scored result, the
 * same "unscored is not zero" rule the comparison report follows.
 */
export interface RunListItem {
  id: string;
  status: RunStatus;
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
  results: RunListResultCounts;
  /** Mean judge score, 0–100. */
  avgScore: number | null;
  /** Share of scored results that passed, 0–1. */
  passRate: number | null;
  topVariantLabel: string | null;
  startedBy: RunListStarter | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
}

/** Query params for `GET /runs` (wire/snake_case shape). */
export interface RunListFilters {
  status?: RunStatus;
  dataset_id?: string;
  prompt_id?: string;
  page?: number;
  limit?: number;
}

// ── Evaluations: comparison report + cell drill-down (E5/E6) ───────────────
/**
 * One entry on the report's prompt-variant axis. The backend's aggregator
 * (`report.aggregate.ts`) never sets a `promptCandidateId` here — a candidate
 * variant is identified only by `variantLabel`; correlate back to a
 * `PromptCandidate` via `Run.grid` (`RunGridCell.promptCandidateId`) instead.
 */
export interface RunReportVariant {
  variantKind: 'version' | 'candidate';
  promptVersionId?: string;
  variantLabel: string;
  isProductionBaseline: boolean;
}

/**
 * A cell's score/pass-rate delta vs. the same-model production-baseline
 * cell. `null` on the baseline cell itself. `label: 'unknown'` when either
 * side has zero scored examples — the delta is not computable, not zero.
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

/** The top-ranked scored cell. `model` is advisory (FAQ Q11) — recorded, not pinned. */
export interface RunReportWinner {
  cellKey: string;
  variantLabel: string;
  model: string;
  avgScore: number;
}

/** GET /runs/:id/report — the full (variant × model) comparison matrix. */
export interface RunReport {
  runId: string;
  status: RunStatus;
  models: string[];
  variants: RunReportVariant[];
  cells: RunReportCell[];
  leaderboard: string[];
  winner: RunReportWinner | null;
}

/**
 * One dataset example's row inside a cell drill-down: the produced output,
 * judge verdict, and the two traces (generation + judge call) behind it.
 * `score`/`passed`/`reason`/`traceId`/`judgeTraceId` are `null` when the
 * example is unscored (judge parse-error or no criterion) — never a fake
 * `0`/`false`.
 */
export interface RunCellExample {
  exampleId: string;
  input: Record<string, unknown>;
  criteria: string | null;
  /** Prior-turn history frozen at run-start (FAQ Q19), or null. */
  history: ChatMessage[] | null;
  output: unknown;
  score: number | null;
  passed: boolean | null;
  reason: string | null;
  traceId: string | null;
  judgeTraceId: string | null;
}

/** GET /runs/:id/cells/:cellKey — on-demand drill-down for one grid cell. */
export interface RunCellDetail {
  cellKey: string;
  variantLabel: string;
  model: string;
  examples: RunCellExample[];
}

// ── Evaluations: optimize loop + promote (E6) ───────────────────────────────
export interface OptimizeInput {
  dataset_id: string;
  models: string[];
  draft_count?: number;
  alias?: string;
}

export interface PromoteCandidateInput {
  prompt_candidate_id: string;
  alias?: string;
}

/** POST /runs/:id/promote response — the newly-committed version + the alias moved onto it. */
export interface PromoteCandidateResult {
  version: VersionDetail;
  alias: AliasDetail;
}

/**
 * GET /runs/:id/candidates/:candidateId response (E7 Task 5) — one
 * optimizer-drafted candidate's own template and rationale, read by the
 * promote-review dialog before a human confirms `POST /runs/:id/promote`.
 */
export interface CandidateDetail {
  id: string;
  promptId: string;
  messages: Message[];
  rationale: string | null;
  label: string;
  createdAt: string;
}

/** Dimension GET /traces/feedback/summary is grouped by. */
export type FeedbackGroupBy = 'prompt_version' | 'model';

/** One grouped bucket in the summary — a prompt version id or a model name. */
export interface FeedbackBucket {
  key: string;
  count: number;
  avgRating: number | null;
  downCount: number;
}

/** Response for GET /traces/feedback/summary. */
export interface FeedbackSummary {
  groupBy: FeedbackGroupBy;
  buckets: FeedbackBucket[];
}

export interface FeedbackSummaryParams {
  from?: string;
  to?: string;
  groupBy?: FeedbackGroupBy;
}

/** Pagination for GET /traces/feedback (the team-wide raw feed, T10). */
export interface FeedbackFeedParams {
  page?: number;
  limit?: number;
}

/** `updatedAt` is null until the team's row has ever been written (lazy default). */
export interface TraceSettings {
  capturePayloads: boolean;
  updatedAt: string | null;
}

export interface UpdateTraceSettingsInput {
  capturePayloads: boolean;
}

// ── Notification preferences ─────────────────────────────────────────────────
/** The coarse categories a user can turn off, per team. */
export type NotificationCategory =
  | 'budget_alerts'
  | 'eval_runs'
  | 'eval_rules'
  | 'membership'
  | 'weekly_digest';

/**
 * Every category with a resolved boolean. The API always returns a complete map —
 * a category with no stored row resolves to `true` server-side — so the UI never
 * has to default a missing key.
 */
export type NotificationPreferences = Record<NotificationCategory, boolean>;

export interface NotificationPreferencesResponse {
  preferences: NotificationPreferences;
}

export interface UpdateNotificationPreferenceInput {
  category: NotificationCategory;
  enabled: boolean;
}

// ── Tool Catalog (TC1–TC5) ───────────────────────────────────────────────────
/** Discriminant for a tool version's executor: client-run vs. gateway-run HTTP call. */
export type ExecutorType = 'client' | 'http';

/** One HTTP header or query-param entry in an `http` executor. */
export interface HttpHeader {
  name: string;
  value: string;
}

/**
 * A tool version's executor. `type: 'client'` is definition-only (the caller's
 * app runs the tool); `type: 'http'` is a declarative HTTP call the gateway
 * itself performs, with optional JS pre/post transforms.
 */
export interface Executor {
  type: ExecutorType;
  url?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: HttpHeader[];
  query?: HttpHeader[];
  bodyTemplate?: string;
  argMapping?: { arg: string; in: 'query' | 'path' | 'header' | 'body'; path?: string }[];
  requestTransform?: string;
  responseTransform?: string;
}

/** A tool's mutable shell (GET /tools list item and single-fetch shape). */
export interface ToolSummary {
  id: string;
  name: string;
  description: string | null;
  teamId: string;
  createdBy: string;
  createdAt: string;
}

/** GET /tools/:id returns the same shape as the list item — no extra fields. */
export type ToolDetail = ToolSummary;

/** Who authored a tool version. Mirrors the API's `ToolVersionSource` enum. */
export type ToolVersionSource = 'code' | 'dashboard' | 'api';

/** Full shape of one immutable tool version (single-fetch and commit responses). */
export interface ToolVersion {
  id: string;
  toolId: string;
  /** What the model reads when deciding whether to call the tool. */
  description: string | null;
  /** Release note for your team. Never shown to the model — that is `description`. */
  changelog: string | null;
  source: ToolVersionSource;
  versionNumber: number;
  parametersSchema: Record<string, unknown>;
  executor: Executor;
  createdBy: string;
  createdAt: string;
  /**
   * Non-fatal advice about the commit that just happened, e.g. a changelog with no
   * description. Absent — not empty — when there is nothing to say.
   */
  warnings?: string[];
}

/** A tool version as it appears in GET /tools/:id/versions (parametersSchema/executor omitted). */
export interface ToolVersionListItem {
  id: string;
  toolId: string;
  versionNumber: number;
  /** What the model reads when deciding whether to call the tool. */
  description: string | null;
  /** Release note for your team. Never shown to the model — that is `description`. */
  changelog: string | null;
  source: ToolVersionSource;
  createdBy: string;
  createdAt: string;
}

/** A resolved tool alias (e.g. `production`) with its target version number. */
export interface ToolAlias {
  id: string;
  alias: string;
  versionId: string;
  versionNumber: number;
  updatedAt: string;
}

/** Body for POST /tools. */
export interface CreateToolInput {
  name: string;
  description?: string;
}

/** Body for POST /tools/:id/versions. */
export interface CommitToolVersionInput {
  description?: string;
  changelog?: string;
  /**
   * Always `'dashboard'` from the web app. The API rejects `'code'` here, so a
   * dashboard commit can never forge code ownership.
   */
  source?: Exclude<ToolVersionSource, 'code'>;
  parametersSchema: Record<string, unknown>;
  executor: Executor;
}

/** Body for POST /tools/:id/execute — pins a version via `alias` or `versionNumber` (defaults to `production`). */
export interface ExecuteToolInput {
  arguments: Record<string, unknown>;
  alias?: string;
  versionNumber?: number;
  /** Trace correlation — nest this tool span into an existing trace (its own row otherwise). */
  traceContext?: { traceId?: string; parentSpanId?: string };
}

/** Response for POST /tools/:id/execute. */
export interface ExecuteResult {
  result: unknown;
  status: number;
  latencyMs: number;
  toolVersionId: string;
}

// ── Secrets (TC4) ────────────────────────────────────────────────────────────
/** Masked secret shape returned by the API — never includes the value or ciphertext. */
export interface Secret {
  id: string;
  name: string;
  lastFour: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Body for POST /secrets. `name` is referenced as `{{secret.NAME}}` in HTTP executors. */
export interface CreateSecretInput {
  name: string;
  value: string;
}

/** GET /tools/analytics response row — one tool's aggregated calls/error-rate/latency. */
export interface ToolStat {
  toolName: string;
  calls: number;
  errorRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

// ── Online Evaluation Rules ──────────────────────────────────────────────────
/** Match conditions for an online-eval rule, all ANDed. Empty matches every `llm` span. */
export interface EvalRuleFilter {
  promptId?: string;
  promptAlias?: string;
  model?: string;
  tags?: string[];
  sessionOnly?: boolean;
}

/** GET/POST/PATCH `/eval-rules` response shape — a rule plus today's aggregate stats. */
export interface EvalRule {
  id: string;
  name: string;
  enabled: boolean;
  kind: 'llm_judge';
  criteria: string;
  judgeModel: string | null;
  judgePromptId: string | null;
  sampleRate: number;
  dailyLimit: number | null;
  alertBelow: number | null;
  filter: EvalRuleFilter;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  todayCount: number;
  todayMeanScore: number | null;
}

/** Body for `POST /eval-rules`. `PATCH /eval-rules/:id` accepts a `Partial` of the same shape. */
export interface CreateEvalRuleInput {
  name: string;
  criteria: string;
  judgeModel: string;
  judgePromptId?: string | null;
  sampleRate?: number;
  dailyLimit?: number | null;
  alertBelow?: number | null;
  filter?: EvalRuleFilter;
  enabled?: boolean;
}

/** One row from `GET /eval-rules/:id/scores` — a persisted judge verdict for one matched span. */
export interface EvalRuleScore {
  id: string;
  ruleId: string;
  traceId: string;
  spanId: string;
  score: number | null;
  passed: boolean | null;
  reason: string | null;
  judgeTraceId: string | null;
  costUsd: number | null;
  createdAt: string;
}

/** Query params for `GET /eval-rules/:id/scores` — already camelCase, no wire-shape mapping needed. */
export interface EvalRuleScoreFilters {
  page?: number;
  limit?: number;
  minScore?: number;
  maxScore?: number;
}

/** One dry-run verdict from `POST /eval-rules/:id/preview`. Scored live against recent spans; never persisted. */
export interface EvalRulePreviewVerdict {
  spanId: string;
  traceId: string;
  score: number | null;
  passed: boolean | null;
  reason: string | null;
}

/** Body for `POST /eval-rules/:id/to-dataset` — builds a dataset from this rule's low-scoring verdicts. */
export interface ToDatasetInput {
  datasetName: string;
  threshold: number;
  limit?: number;
}

/** Response for `POST /eval-rules/:id/to-dataset`. */
export interface ToDatasetResult {
  id: string;
  exampleCount: number;
}
