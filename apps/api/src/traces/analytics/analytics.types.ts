import { z } from 'zod';

/**
 * Dimension the analytics aggregate is grouped by. `span_name` buckets by the step name
 * inside a trace (`search_docs`, `draft-reply`), which shows which step is slow, failing
 * or expensive; pair it with the `kind` filter to look at one kind of step only.
 */
export const GroupBySchema = z.enum(['day', 'model', 'session', 'prompt_version', 'span_name']);
export type GroupBy = z.infer<typeof GroupBySchema>;

/** span_kind enum values (conventions §1). Used for the optional `kind` filter. */
export const SpanKindSchema = z.enum([
  'llm',
  'tool',
  'retrieval',
  'embedding',
  'agent',
  'chain',
  'other',
]);
export type SpanKind = z.infer<typeof SpanKindSchema>;

/**
 * Query params for GET /traces/analytics.
 * `from`/`to` are ISO dates (coerced to Date; invalid strings → 400). When omitted
 * the service defaults to the last 30 days. `group_by` defaults to `day`. `kind`
 * and `model` are optional narrowing filters.
 *
 * @throws (via safeParse) VALIDATION_ERROR if `from` is after `to`.
 */
export const AnalyticsQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    group_by: GroupBySchema.default('day'),
    kind: SpanKindSchema.optional(),
    model: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.from && data.to && data.from > data.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`from` must be on or before `to`.',
      });
    }
  });
export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

/** Latency percentiles in milliseconds; null when a group has no timed spans. */
export interface LatencyPercentiles {
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/** Aggregate metrics — shared shape for the range totals and each grouped bucket. */
export interface AnalyticsTotals {
  requests: number;
  errorRate: number; // 0..1 — errored spans / total spans
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number; // null cost_usd summed as 0
  latencyMs: LatencyPercentiles;
}

/** One grouped bucket (a day, a model, a session id, a prompt-version id, or a span name). */
export interface AnalyticsBucket extends AnalyticsTotals {
  key: string;
}

/**
 * Cost of one trace (the sum of its spans' `cost_usd` that match the filters), as a
 * distribution over the traces in the window. Null when no trace is in the window.
 */
export interface CostPerTrace {
  p50: number | null;
  p99: number | null;
}

/** Response for GET /traces/analytics. */
export interface AnalyticsResponse {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  groupBy: GroupBy;
  totals: AnalyticsTotals;
  costPerTrace: CostPerTrace;
  buckets: AnalyticsBucket[];
}

/**
 * Query params for GET /traces/analytics/scores. Same window rules as the main
 * analytics query, applied to when a verdict was recorded (`created_at`).
 *
 * @throws (via safeParse) VALIDATION_ERROR if `from` is after `to`.
 */
export const ScoresQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.from && data.to && data.from > data.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '`from` must be on or before `to`.' });
    }
  });
export type ScoresQuery = z.infer<typeof ScoresQuerySchema>;

/** Thumbs feedback counts: ratings of 1 (up) and -1 (down), the only ratings the API accepts. */
export interface FeedbackCounts {
  up: number;
  down: number;
}

/** One online-evaluation rule's verdicts in the window. Unscored judge calls are left out. */
export interface RuleScoreSummary {
  ruleId: string;
  name: string;
  /** Verdicts with a pass/fail result. */
  scored: number;
  passed: number;
  failed: number;
  /** Mean 0–100 score over verdicts that have one; null when none do. */
  avgScore: number | null;
}

/** One UTC day of the trend: thumbs counts and verdicts summed over every rule. */
export interface ScoreDay extends FeedbackCounts {
  day: string; // YYYY-MM-DD
  passed: number;
  failed: number;
}

/** Response for GET /traces/analytics/scores. */
export interface ScoresResponse {
  from: string; // YYYY-MM-DD, first day in the window
  to: string; // YYYY-MM-DD, last day in the window (the query's `to` is exclusive)
  feedback: FeedbackCounts;
  rules: RuleScoreSummary[];
  days: ScoreDay[];
}
