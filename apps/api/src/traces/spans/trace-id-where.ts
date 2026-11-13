import type { Prisma } from '@prisma/client';

/**
 * The `where` clause that finds a team's trace by the id a caller uses for it.
 *
 * A trace id is chosen by the caller (native ingest, OTLP, the gateway's `x-trace-id`,
 * a tool call's trace context), so two teams can pick the same one. The first team to
 * report an id stores it as `traces.id`. A later team reporting the same id gets a row
 * with a server-generated `id` and the caller's id in `client_trace_id`. Matching either
 * column, always inside the team, is what lets each team find its own trace by the id it
 * sent, while another team's row with that id stays invisible.
 *
 * Pair it with {@link TRACE_ID_MATCH_ORDER}: should one team ever hold a row under each
 * column for the same id, the row stored under `id` wins, so every read picks the same one.
 *
 * @param teamId - Isolation boundary; the clause never matches another team's row.
 * @param traceId - The id the caller used: a stored `traces.id` or a caller-chosen id.
 *   Must be a UUID string, as Prisma rejects anything else for a `@db.Uuid` column.
 * @returns A Prisma `where` for `prisma.trace.findFirst`.
 */
export function traceIdWhere(teamId: string, traceId: string): Prisma.TraceWhereInput {
  return { teamId, OR: [{ id: traceId }, { clientTraceId: traceId }] };
}

/**
 * Order for a lookup by {@link traceIdWhere}: a row whose `id` is the caller's id (its
 * `client_trace_id` is null) before a row that records it in `client_trace_id`.
 */
export const TRACE_ID_MATCH_ORDER: Prisma.TraceOrderByWithRelationInput = {
  clientTraceId: { sort: 'asc', nulls: 'first' },
};
