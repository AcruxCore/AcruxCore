import { z } from 'zod';
import { TraceFilterQuerySchema } from '../filters';
import type { TraceFilters } from '../filters';
import { FeedbackDto } from '../feedback';

/**
 * Query params for GET /traces: the shared trace filter vocabulary
 * ({@link TraceFilterQuerySchema}) plus pagination. Every filter documented
 * there applies here unchanged, so a filter added for the feedback feed or the
 * dataset builders shows up on this endpoint too. `from`/`to` default in the
 * service to the last 30 days; `limit` is capped at 100.
 */
export const TraceListQuerySchema = TraceFilterQuerySchema.extend({
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
 * The repository-facing shape for GET /traces: the shared {@link TraceFilters}
 * plus the pagination this surface owns. Pagination lives here rather than in
 * the shared filter type because the dataset builders select by criteria with
 * no pages at all.
 */
export interface TraceListFilters extends TraceFilters {
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
  /**
   * Whether any span on this trace carries a `warning` attribute — something seen and
   * worth reading, on a run that did not fail. A gateway call answered by a fallback
   * model is the common case: it is `ok`, so without this flag the list cannot tell it
   * from a call the primary model served itself.
   */
  hasWarning: boolean;
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
