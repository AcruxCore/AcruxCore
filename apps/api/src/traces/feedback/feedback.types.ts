import { z } from 'zod';
import { TraceFilterQuerySchema, toTraceFilters } from '../filters';
import type { TraceFilters } from '../filters';

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
export interface FeedbackAuthor {
  id: string;
  /** The member's display name, or null when they never set one. */
  name: string | null;
  email: string;
}

export interface FeedbackDto {
  id: string;
  traceId: string;
  spanId: string | null;
  rating: number | null;
  label: string | null;
  comment: string | null;
  source: string;
  createdBy: string | null;
  /**
   * The team member who posted this, when there is one. `source` alone says
   * "developer" but not *which* developer, which is the thing a reviewer needs
   * when several people triage the same feedback list. Null for rows posted via
   * a team-scoped API key or by an end user — there is no user behind those.
   */
  author: FeedbackAuthor | null;
  createdAt: string;
  updatedAt: string;
}

/** One grouped bucket in the summary — a prompt version id or a model name. */
export interface FeedbackBucket {
  key: string;
  /**
   * Human-readable name for the bucket (#383). For `model` grouping this is the
   * model name — identical to `key`. For `prompt_version` grouping it is
   * `"<prompt name> v<version number>"`, falling back to the raw id when the
   * version row no longer exists. `key` deliberately stays the raw id so
   * anything keying off it keeps working.
   */
  label: string;
  /**
   * The prompt owning this version, so the dashboard can link the bucket to its
   * prompt. Always null for `model` grouping and for an unresolvable version id.
   */
  promptId: string | null;
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

/** How a feedback row's rating narrows a search. */
export const FeedbackRatingFilterSchema = z.enum(['up', 'down', 'none']);
/** `up` = rating > 0, `down` = rating < 0, `none` = no rating at all. */
export type FeedbackRatingFilter = z.infer<typeof FeedbackRatingFilterSchema>;

/**
 * A boolean that survives a query string. `z.coerce.boolean()` cannot be used
 * here: it applies JavaScript truthiness, so `?has_comment=false` arrives as
 * the string `"false"` and coerces to `true` — the exact opposite of what was
 * asked for.
 */
const BooleanParamSchema = z.union([
  z.boolean(),
  z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1'),
]);

/**
 * The feedback filter vocabulary: every trace filter (they all describe the
 * feedback row's trace) plus the four that only make sense on a critique.
 *
 * `has_comment` earns its place in dataset building specifically — the comment
 * becomes an example's judge criteria, so a row without one yields a weaker
 * example and is usually worth excluding up front.
 *
 * Note that `from`/`to` window the FEEDBACK row's `created_at`, not the trace's:
 * a critique is often written days after the run it grades, and "the feedback I
 * left this week" is what someone filtering this list means.
 */
export const FeedbackFilterSchema = TraceFilterQuerySchema.extend({
  rating: FeedbackRatingFilterSchema.optional(),
  source: FeedbackSourceSchema.optional(),
  label: z.string().min(1).max(200).optional(),
  has_comment: BooleanParamSchema.optional(),
});
/** Parsed feedback filters in their wire (snake_case) shape. */
export type FeedbackFilterQuery = z.infer<typeof FeedbackFilterSchema>;

/**
 * Query params for GET /traces/feedback (T10) — the team-wide raw feed behind
 * the feedback page and the dataset "add rows" dialog. The full filter set plus
 * pagination; `limit` capped at 100 like the other list surfaces.
 */
export const FeedbackListQuerySchema = FeedbackFilterSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type FeedbackListQuery = z.infer<typeof FeedbackListQuerySchema>;

/**
 * Internal (camelCase) feedback filters, as the repository consumes them.
 * Extends the shared {@link TraceFilters} because a feedback row is selected
 * through its trace.
 */
export interface FeedbackFilters extends TraceFilters {
  rating?: FeedbackRatingFilter;
  source?: string;
  label?: string;
  hasComment?: boolean;
}

/**
 * Maps validated wire feedback filters to the internal camelCase shape.
 *
 * @param query - Validated snake_case filters from a query string or JSON body.
 * @returns The equivalent camelCase filters.
 */
export function toFeedbackFilters(query: FeedbackFilterQuery): FeedbackFilters {
  return {
    ...toTraceFilters(query),
    rating: query.rating,
    source: query.source,
    label: query.label,
    hasComment: query.has_comment,
  };
}

/** Paginated envelope for GET /traces/feedback. */
export interface FeedbackListResponse {
  data: FeedbackDto[];
  total: number;
  page: number;
  limit: number;
}
