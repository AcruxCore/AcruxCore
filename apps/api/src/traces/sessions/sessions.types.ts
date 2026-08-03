import { z } from 'zod';

/**
 * Query params for GET /api/v1/sessions.
 * `from`/`to` are ISO dates (coerced to Date; invalid strings → 400). When omitted
 * the service defaults to the last 30 days. `limit` is capped at 100. `q` is an
 * optional case-insensitive substring match on `session_id` (empty or whitespace-only
 * values are treated as "no filter" and parse to `undefined` rather than failing).
 */
export const SessionListQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z
    .string()
    .trim()
    .transform((v) => (v === '' ? undefined : v))
    .optional(),
});
export type SessionListQuery = z.infer<typeof SessionListQuerySchema>;

/**
 * One rolled-up session: a distinct `traces.session_id` for the team, with its
 * trace count, summed cost/tokens, and activity time span. `totalCostUsd` is null
 * when none of the session's traces carried a cost.
 */
export interface SessionSummary {
  sessionId: string;
  traceCount: number;
  totalCostUsd: number | null;
  totalTokens: number;
  firstAt: string; // ISO — MIN(started_at)
  lastAt: string; // ISO — MAX(started_at)
}

/**
 * One trace inside a session (newest-first in the detail response). Carries
 * `tags` and `sessionId` so the item satisfies the web client's `TraceListItem`
 * shape — the shared `TraceTable` component renders a Tags cell unconditionally.
 */
export interface SessionTraceItem {
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
}

/** Paginated envelope for GET /api/v1/sessions. */
export interface SessionListResponse {
  data: SessionSummary[];
  total: number;
  page: number;
  limit: number;
}

/** Response for GET /api/v1/sessions/:id — the session summary plus its traces. */
export interface SessionDetailResponse {
  session: SessionSummary;
  traces: SessionTraceItem[];
}
