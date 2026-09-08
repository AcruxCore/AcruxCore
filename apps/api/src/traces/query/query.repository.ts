import prisma from '../../shared/db/client';
import { Prisma } from '@prisma/client';
import type { TraceListFilters, TraceListItem } from './query.types';
import { buildTraceConditions } from '../filters';
import type { TraceRow, SpanRow, SpanPayloadRow } from '../../shared/db/schema';

/** Raw row shape returned by the list query before Date→ISO mapping. */
interface TraceListRaw {
  id: string;
  name: string | null;
  sessionId: string | null;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  spanCount: number;
  totalCostUsd: number | null;
  totalTokens: number;
  durationMs: number | null;
  tags: string[];
}

/**
 * Read-only data access over `traces`/`spans` for the query surface. All queries
 * are team-scoped and hit the single uniform span table (no UNION). Span-level
 * filters resolve via `EXISTS (SELECT 1 FROM spans …)` so the row returned is the
 * trace. `groupBy`-free casts (`::int`, `::float8`, `status::text`) make raw rows
 * deserialize straight into JS numbers/strings.
 */
export class TraceQueryRepository {
  /** Maps a raw list row to the API DTO (timestamps → ISO strings). */
  private toListItem(r: TraceListRaw): TraceListItem {
    return {
      id: r.id,
      name: r.name,
      sessionId: r.sessionId,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
      spanCount: r.spanCount,
      totalCostUsd: r.totalCostUsd,
      totalTokens: r.totalTokens,
      durationMs: r.durationMs,
      tags: r.tags,
    };
  }

  /**
   * Runs the shared list SELECT + COUNT for a given WHERE fragment. Ordered
   * newest-first by `created_at` (matches idx_traces_team_time).
   *
   * @param where - A Prisma.Sql boolean expression over alias `t` (traces).
   * @param page - 1-based page.
   * @param limit - Page size (already capped at 100 upstream).
   * @returns Mapped page rows and the full matching count.
   */
  private async runList(
    where: Prisma.Sql,
    page: number,
    limit: number,
  ): Promise<{ data: TraceListItem[]; total: number }> {
    const offset = (page - 1) * limit;

    const rows = await prisma.$queryRaw<TraceListRaw[]>(Prisma.sql`
      SELECT
        t.id,
        t.name,
        t.session_id AS "sessionId",
        t.status::text AS "status",
        t.started_at AS "startedAt",
        t.ended_at AS "endedAt",
        t.span_count AS "spanCount",
        t.total_cost_usd::float8 AS "totalCostUsd",
        t.total_tokens AS "totalTokens",
        CASE WHEN t.ended_at IS NULL THEN NULL
             ELSE (EXTRACT(EPOCH FROM (t.ended_at - t.started_at)) * 1000)::int END AS "durationMs",
        t.tags
      FROM traces t
      WHERE ${where}
      ORDER BY t.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const totalRows = await prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS "total" FROM traces t WHERE ${where}
    `);

    return { data: rows.map((r) => this.toListItem(r)), total: totalRows[0].total };
  }

  /**
   * Lists traces newest-first with optional filters.
   *
   * Every condition beyond team scope comes from {@link buildTraceConditions},
   * the one filter definition this endpoint shares with the feedback feed and
   * the dataset builders — so `?prompt_id=` means the same thing everywhere,
   * and a filter is never added to one surface and forgotten on another.
   *
   * @param teamId - Team scope.
   * @param filters - Resolved (camelCase) filters incl. page/limit.
   * @returns Page of trace list items and the total matching count.
   */
  async listTraces(
    teamId: string,
    filters: TraceListFilters,
  ): Promise<{ data: TraceListItem[]; total: number }> {
    const conds: Prisma.Sql[] = [
      Prisma.sql`t.team_id = ${teamId}::uuid`,
      ...buildTraceConditions(filters, 't'),
    ];

    return this.runList(Prisma.join(conds, ' AND '), filters.page, filters.limit);
  }

  /**
   * Fetches a trace and its flat span list, scoped to the team, plus any captured
   * payload rows keyed by internal span id. Returns null when the trace is not in
   * the team. Spans are ordered by `started_at` so the tree builder nests children
   * in start order.
   *
   * @param teamId - Team scope.
   * @param traceId - Internal trace UUID.
   * @returns `{ trace, spans, payloads? }`, or null if not found in this team.
   */
  async getTrace(
    teamId: string,
    traceId: string,
  ): Promise<{ trace: TraceRow; spans: SpanRow[]; payloads?: Record<string, SpanPayloadRow> } | null> {
    const trace = await prisma.trace.findFirst({ where: { id: traceId, teamId } });
    if (!trace) return null;

    const spans = await prisma.span.findMany({
      where: { traceId, teamId },
      orderBy: { startedAt: 'asc' },
    });

    const payloadRows = await prisma.spanPayload.findMany({
      where: { spanId: { in: spans.map((s) => s.id) }, teamId },
    });

    const payloads =
      payloadRows.length > 0
        ? Object.fromEntries(payloadRows.map((p) => [p.spanId, p]))
        : undefined;

    return { trace, spans, payloads };
  }

  /**
   * Lists traces (newest-first, paginated) whose spans reference a given prompt
   * version. Same list shape as {@link listTraces}; no date default — the reverse
   * lineage lists all matching traces.
   *
   * @param teamId - Team scope.
   * @param promptVersionId - The resolved prompt_versions UUID.
   * @param page - 1-based page.
   * @param limit - Page size (capped at 100 upstream).
   * @returns Page of trace list items and the total matching count.
   */
  async tracesForPromptVersion(
    teamId: string,
    promptVersionId: string,
    page: number,
    limit: number,
  ): Promise<{ data: TraceListItem[]; total: number }> {
    const where = Prisma.sql`t.team_id = ${teamId}::uuid AND EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = t.id AND s.prompt_version_id = ${promptVersionId}::uuid)`;
    return this.runList(where, page, limit);
  }
}
