import { z } from 'zod';

/** Where a piece of feedback came from. Mirrors the `source` TEXT column default 'user'. */
export const FeedbackSourceSchema = z.enum(['user', 'developer', 'end_user', 'api']);

/** A feedback source value. */
export type FeedbackSource = z.infer<typeof FeedbackSourceSchema>;

/**
 * Body for POST /traces/:id/feedback. `rating`, `label`, and `comment` are each
 * optional, but the refine below requires at least one. `rating` is a permissive
 * integer in [-1, 5] (a ±1 thumbs schema and a 1–5 score both fit). `spanId`, when
 * present, is the caller-supplied span reference (the OTel span id returned by
 * GET /traces/:id), resolved to a span within the trace by the service.
 */
export const CreateFeedbackSchema = z
  .object({
    rating: z
      .number()
      .int('rating must be an integer.')
      .min(-1, 'rating must be between -1 and 5.')
      .max(5, 'rating must be between -1 and 5.')
      .optional(),
    label: z.string().min(1).max(200, 'label must be 200 characters or fewer.').optional(),
    comment: z.string().min(1).max(5000, 'comment must be 5000 characters or fewer.').optional(),
    spanId: z.string().min(1).optional(),
    source: FeedbackSourceSchema.default('user'),
  })
  .refine(
    (d) => d.rating !== undefined || d.label !== undefined || d.comment !== undefined,
    { message: 'Provide at least one of rating, label, or comment.' },
  );

/** Validated create payload. */
export type CreateFeedbackDto = z.infer<typeof CreateFeedbackSchema>;

/**
 * Body for PATCH /traces/:id/feedback/:feedbackId. Each field is `.nullable()`
 * so the service can distinguish "not sent, leave unchanged" (key absent) from
 * "explicitly clear this field" (`null`) from "set this value". The merged
 * result (existing + patch) must still have at least one of rating/label/comment
 * — enforced in the service, since it needs the existing row to check that.
 */
export const UpdateFeedbackSchema = z.object({
  rating: z
    .number()
    .int('rating must be an integer.')
    .min(-1, 'rating must be between -1 and 5.')
    .max(5, 'rating must be between -1 and 5.')
    .nullable()
    .optional(),
  label: z.string().min(1).max(200, 'label must be 200 characters or fewer.').nullable().optional(),
  comment: z.string().min(1).max(5000, 'comment must be 5000 characters or fewer.').nullable().optional(),
});

/** Validated update payload. */
export type UpdateFeedbackDto = z.infer<typeof UpdateFeedbackSchema>;

/** Dimension the summary aggregate is grouped by. */
export const FeedbackGroupBySchema = z.enum(['prompt_version', 'model']);
export type FeedbackGroupBy = z.infer<typeof FeedbackGroupBySchema>;

/**
 * Query params for GET /traces/feedback/summary. `from`/`to` are ISO dates
 * (coerced; invalid strings → 400). When omitted the service defaults to the last
 * 30 days. `group_by` defaults to `prompt_version`.
 */
export const FeedbackSummaryQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  group_by: FeedbackGroupBySchema.default('prompt_version'),
});
export type FeedbackSummaryQuery = z.infer<typeof FeedbackSummaryQuerySchema>;

/**
 * A single feedback row as returned by the API. `spanId` is the span *reference*
 * (null for whole-trace feedback), not the internal UUID — symmetric with the
 * `spanId` clients see in GET /traces/:id.
 */
export interface FeedbackDto {
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

/** One grouped bucket in the summary — a prompt version id or a model name. */
export interface FeedbackBucket {
  key: string;
  count: number;
  /** Mean of non-null ratings in the bucket; null when the bucket has no ratings. */
  avgRating: number | null;
  /** Count of feedback rows with rating < 0 (thumbs-down). */
  downCount: number;
}

/** Response for GET /traces/feedback/summary. */
export interface FeedbackSummary {
  groupBy: FeedbackGroupBy;
  buckets: FeedbackBucket[];
}

/**
 * Query params for GET /traces/feedback (T10) — the team-wide raw feed backing
 * the feedback visualization page. Pagination only; `limit` capped at 100 like
 * the other list surfaces.
 */
export const FeedbackListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type FeedbackListQuery = z.infer<typeof FeedbackListQuerySchema>;

/** Paginated envelope for GET /traces/feedback. */
export interface FeedbackListResponse {
  data: FeedbackDto[];
  total: number;
  page: number;
  limit: number;
}
