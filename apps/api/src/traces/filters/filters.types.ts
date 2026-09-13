import { z } from 'zod';
import { SPAN_ERROR_TYPES } from '../spans/span-failure';

/**
 * Which part of a trace the free-text `q` searches.
 *
 * `all` (the default) searches the trace name, span names, span attributes and
 * both halves of every captured payload. The narrower scopes exist because a
 * word like "London" appears in a user's question and in the assistant's answer
 * for different reasons, and an operator triaging a complaint usually means one
 * or the other.
 */
export const QueryScopeSchema = z.enum(['all', 'input', 'output', 'name']);

/**
 * A boolean filter that survives both wire shapes this vocabulary travels in: a query
 * string, where it arrives as text, and a JSON `filter` body, where it is a real boolean.
 *
 * `z.coerce.boolean()` cannot be used: it applies JavaScript truthiness, so
 * `?has_warning=false` arrives as the string `"false"` and coerces to `true` — the exact
 * opposite of what was asked for.
 */
export const BooleanParamSchema = z.union([
  z.boolean(),
  z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1'),
]);

/** Which part of a trace `q` searches. */
export type QueryScope = z.infer<typeof QueryScopeSchema>;

/**
 * The filter vocabulary shared by every surface that selects traces: the trace
 * list, the team-wide feedback feed, and the dataset `from-feedback` endpoints.
 * Snake_case because these are wire names — query params on the list surfaces
 * and JSON keys inside the dataset endpoints' `filter` body.
 *
 * `from`/`to` window the trace's `created_at` as `[from, to)`. Callers decide
 * their own defaults: the trace list falls back to the last 30 days, the
 * feedback feed applies the window to the feedback row instead (a critique is
 * often written days after the run it grades).
 *
 * `tags` accepts one repeated `?tags=` value or several and matches traces
 * carrying ALL of them; `metadata` is bracket notation (`?metadata[env]=prod`)
 * and matches traces whose metadata contains every supplied pair.
 *
 * `prompt_id` and `prompt_version_id` are both "the trace has at least one span
 * that used this" — `prompt_version_id` is a column on `spans`, not on
 * `traces`, so one trace can legitimately involve several prompts.
 *
 * `error_type`, `error_code` and `has_warning` read span attributes rather than trace
 * columns, for the same reason: the question "which runs broke because an upstream tool
 * 500'd" is about one span inside the trace, and `status: error` alone cannot answer it —
 * every kind of failure rolls up to the same red trace.
 *
 * `error_type` is a closed set and `error_code` a free string, because they answer
 * different questions: the type is one of six platform classifications, while the code is
 * whatever slug the tool's owner chose for their own failure mode. A team invents its own
 * codes, so no enum here could know them.
 */
export const TraceFilterQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: z.enum(['ok', 'error', 'unset']).optional(),
  error_type: z.enum(SPAN_ERROR_TYPES as unknown as [string, ...string[]]).optional(),
  error_code: z.string().min(1).optional(),
  has_warning: BooleanParamSchema.optional(),
  model: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  prompt_id: z.string().uuid().optional(),
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
  q_in: QueryScopeSchema.default('all'),
  tags: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  metadata: z.record(z.string()).optional(),
});

/** Parsed trace filters in their wire (snake_case) shape. */
export type TraceFilterQuery = z.infer<typeof TraceFilterQuerySchema>;

/**
 * Internal (camelCase) trace filter shape, as repositories consume it. Every
 * field narrows the result set; an all-undefined object matches every trace in
 * the team. Pagination is deliberately absent — it belongs to the surface, not
 * to the filter language.
 */
export interface TraceFilters {
  from?: Date;
  to?: Date;
  status?: string;
  errorType?: string;
  errorCode?: string;
  hasWarning?: boolean;
  model?: string;
  sessionId?: string;
  promptId?: string;
  promptVersionId?: string;
  minLatencyMs?: number;
  minCostUsd?: number;
  minTokens?: number;
  minScore?: number;
  maxScore?: number;
  ruleId?: string;
  q?: string;
  qIn?: QueryScope;
  tags?: string[];
  metadata?: Record<string, string>;
}

/**
 * Maps validated wire filters to the internal camelCase shape. One function so
 * a new filter is wired into every surface by adding it here once, rather than
 * being remembered separately in each service.
 *
 * @param query - Validated snake_case filters from a query string or JSON body.
 * @returns The equivalent camelCase filters.
 */
export function toTraceFilters(query: TraceFilterQuery): TraceFilters {
  return {
    from: query.from,
    to: query.to,
    status: query.status,
    errorType: query.error_type,
    errorCode: query.error_code,
    hasWarning: query.has_warning,
    model: query.model,
    sessionId: query.session_id,
    promptId: query.prompt_id,
    promptVersionId: query.prompt_version_id,
    minLatencyMs: query.min_latency_ms,
    minCostUsd: query.min_cost_usd,
    minTokens: query.min_tokens,
    minScore: query.min_score,
    maxScore: query.max_score,
    ruleId: query.rule_id,
    q: query.q,
    qIn: query.q_in,
    tags: query.tags,
    metadata: query.metadata,
  };
}
