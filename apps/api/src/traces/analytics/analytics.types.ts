import { z } from 'zod';

/** Dimension the analytics aggregate is grouped by. */
export const GroupBySchema = z.enum(['day', 'model', 'session', 'prompt_version']);
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

/** One grouped bucket (a day, a model, a session id, or a prompt-version id). */
export interface AnalyticsBucket extends AnalyticsTotals {
  key: string;
}

/** Response for GET /traces/analytics. */
export interface AnalyticsResponse {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  groupBy: GroupBy;
  totals: AnalyticsTotals;
  buckets: AnalyticsBucket[];
}
