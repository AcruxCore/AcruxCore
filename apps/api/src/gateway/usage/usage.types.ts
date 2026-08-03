import { z } from 'zod';

/** Dimension the usage aggregate is grouped by. */
export const GroupBySchema = z.enum(['day', 'model', 'virtual_key', 'provider']);
export type GroupBy = z.infer<typeof GroupBySchema>;

/**
 * Query params for GET /gateway/usage.
 * `from`/`to` are ISO dates (coerced to Date; invalid strings → 400). When omitted
 * the service defaults to the last 30 days. `group_by` defaults to `day`.
 */
export const UsageQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  group_by: GroupBySchema.default('day'),
  virtual_key_id: z.string().uuid().optional(),
});
export type UsageQuery = z.infer<typeof UsageQuerySchema>;

/**
 * Query params for GET /gateway/requests (paginated request log).
 * `limit` is capped at 100.
 */
export const RequestListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  virtual_key_id: z.string().uuid().optional(),
  model: z.string().min(1).optional(),
  status: z.enum(['success', 'error', 'cache_hit']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type RequestListQuery = z.infer<typeof RequestListQuerySchema>;

/** Aggregate totals across the whole date range. */
export interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  cacheHitRate: number; // 0..1
  errorRate: number; // 0..1
}

/** One grouped bucket (a day, a model, a virtual key, or a provider). */
export interface UsageBucket {
  key: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/** Response for GET /gateway/usage. */
export interface UsageResponse {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  groupBy: GroupBy;
  totals: UsageTotals;
  buckets: UsageBucket[];
}

/** One row in the request log. No message bodies are stored in v1 (privacy default). */
export interface RequestListItem {
  id: string;
  createdAt: string;
  virtualKeyId: string | null;
  provider: string | null;
  requestedModel: string;
  resolvedModel: string | null;
  status: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  latencyMs: number | null;
  cacheHit: boolean;
  promptVersionId: string | null;
  errorCode: string | null;
}

/** Paginated envelope for GET /gateway/requests. */
export interface RequestListResponse {
  data: RequestListItem[];
  total: number;
  page: number;
  limit: number;
}
