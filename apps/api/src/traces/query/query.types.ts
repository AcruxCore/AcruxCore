import { z } from 'zod';
import { FeedbackDto } from '../feedback';

/**
 * Query params for GET /traces. All filters optional. `from`/`to` are ISO dates
 * (coerced to Date; invalid strings → 400) and default in the service to the last
 * 30 days. `limit` is capped at 100. Snake_case names mirror the wire contract.
 * `status` mirrors T1's `span_status` Postgres enum exactly (local literal set,
 * consistent with T2's `ingest.types.ts`). `q` is an optional free-text filter
 * (empty or whitespace-only values are treated as "no filter" and parse to
 * `undefined` rather than failing), matching the sessions endpoint (FAQ Q8).
 * `tags` (T8) accepts either a single repeated `?tags=` value (a plain string,
 * per `qs`'s parsing of a lone occurrence) or several (an array) — both coerce to
 * a string array; matches traces containing ALL supplied tags (FAQ Q10). `metadata`
 * (T8) is bracket-notation query params (`?metadata[env]=prod`), matching traces
 * whose metadata contains every supplied key/value pair. `min_score`/`max_score`
 * (online eval) match traces with an `eval_rule_scores` row at or above/below the
 * threshold; `rule_id` narrows that to a specific rule — all three are ANDed with
 * everything else and independent of each other (no rule_id required for
 * min/max_score).
 */
export const TraceListQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: z.enum(['ok', 'error', 'unset']).optional(),
  model: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  prompt_version_id: z.string().uuid().optional(),
  min_latency_ms: z.coerce.number().int().min(0).optional(),
  min_cost_usd: z.coerce.number().min(0).optional(),
  min_tokens: z.coerce.number().int().min(0).optional(),
  min_score: z.coerce.number().int().min(0).max(100).optional(),
  max_score: z.coerce.number().int().min(0).max(100).optional(),
  rule_id: z.string().uuid().optional(),
  q: z
    .string()
    .trim()
    .transform((v) => (v === '' ? undefined : v))
    .optional(),
  tags: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  metadata: z.record(z.string()).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
/** Parsed query params for GET /traces (wire/snake_case shape, post-coercion). */
export type TraceListQuery = z.infer<typeof TraceListQuerySchema>;

/** Query params for GET /prompts/:id/versions/:n/traces (pagination only). */
export const PromptVersionTracesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
/** Parsed query params for GET /prompts/:id/versions/:n/traces. */
export type PromptVersionTracesQuery = z.infer<typeof PromptVersionTracesQuerySchema>;

/**
 * Internal (camelCase) filter shape passed from the service into the repository.
 * `page`/`limit` are always present; every other field narrows the result set.
 */
export interface TraceFilters {
  from?: Date;
  to?: Date;
  status?: string;
  model?: string;
  sessionId?: string;
  promptVersionId?: string;
  minLatencyMs?: number;
  minCostUsd?: number;
  minTokens?: number;
  minScore?: number;
  maxScore?: number;
  ruleId?: string;
  q?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  page: number;
  limit: number;
}

/** One row in the trace list. `durationMs` = ended_at − started_at (null if open). */
export interface TraceListItem {
  id: string;
  name: string | null;
  sessionId: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  spanCount: number;
  totalCostUsd: number | null;
  totalTokens: number;
  durationMs: number | null;
  tags: string[];
}

/** Paginated envelope for GET /traces and the reverse-lineage endpoint. */
export interface TraceListResponse {
  data: TraceListItem[];
  total: number;
  page: number;
  limit: number;
}

/**
 * One span in the detail tree. `spanId`/`parentSpanId` are the caller-supplied
 * OTel refs (`span_ref`/`parent_span_ref`), not the internal UUID. `payload` is
 * present only when a `span_payloads` row exists for this span. `tags`/`metadata`
 * (T9) default to `[]`/`{}` (FAQ Q13).
 */
export interface SpanNode {
  spanId: string;
  parentSpanId: string | null;
  kind: string;
  name: string;
  status: string;
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
  payload?: { input: unknown; output: unknown; variables: unknown };
  children: SpanNode[];
}

/** The trace header shown alongside the span tree in GET /traces/:id. */
export interface TraceSummary {
  id: string;
  name: string | null;
  sessionId: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  spanCount: number;
  totalCostUsd: number | null;
  totalTokens: number;
  tags: string[];
  metadata: Record<string, unknown>;
}

/**
 * One online-eval rule score attached to a trace, with the scoring rule's
 * name resolved so the trace detail page doesn't need a second lookup.
 * `score`/`passed`/`reason`/`judgeTraceId` are all `null` when the rule
 * matched a span but payload capture was off for the team, so the judge was
 * never called (Task 9's first-class "unscored" outcome).
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

/**
 * Full response for GET /traces/:id. `feedback` (T6) is the trace's feedback
 * rows, newest-first — same shape as `GET /traces/:id/feedback`'s `data`.
 * `evalScores` (online eval) is this trace's rule-score rows, newest-first,
 * surfaced the same additive way.
 */
export interface TraceDetail {
  trace: TraceSummary;
  spans: SpanNode[];
  feedback: FeedbackDto[];
  evalScores: EvalScoreDto[];
}
