import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import type { Trace } from '../../shared/db/schema';
import type { SessionSummary, SessionTraceItem } from './sessions.types';

/** Maximum number of traces returned by {@link SessionsRepository.getSession}. */
export const SESSION_TRACES_CAP = 100;

/**
 * Shape of a raw grouped-aggregate row from `$queryRaw`. `totalCostUsd` is a
 * `float8` (JS number) via the SQL cast, and is null when SUM(total_cost_usd)
 * over the session is null (no trace carried a cost). Timestamps come back as
 * JS `Date` objects for `timestamptz` columns.
 */
interface SessionAggRow {
  sessionId: string;
  traceCount: number;
  totalCostUsd: number | null;
  totalTokens: number;
  firstAt: Date;
  lastAt: Date;
}

/**
 * Read-only data access for sessions, derived from the T1 `traces` table. All
 * queries are team-scoped. The grouped aggregate + distinct count use raw SQL
 * (`Prisma.sql`) because `GROUP BY session_id` with aggregate ordering is not
 * expressible in the query builder; the per-session trace list uses the builder.
 */
export class SessionsRepository {
  /**
   * Maps a raw aggregate row to the public `SessionSummary` DTO. Shared by
   * {@link listSessions} and {@link getSession} so the two endpoints never drift.
   *
   * @param row - One `$queryRaw` aggregate row.
   * @returns The `SessionSummary` with ISO timestamps.
   */
  private toSummary(row: SessionAggRow): SessionSummary {
    return {
      sessionId: row.sessionId,
      traceCount: row.traceCount,
      totalCostUsd: row.totalCostUsd,
      totalTokens: row.totalTokens,
      firstAt: row.firstAt.toISOString(),
      lastAt: row.lastAt.toISOString(),
    };
  }

  /**
   * Lists the team's distinct sessions over a date window, newest activity first,
   * paginated. A session is a distinct non-null `traces.session_id`. `q` narrows
   * by a case-insensitive substring of `session_id`.
   *
   * @param teamId - Team scope.
   * @param opts - Resolved window (`from` inclusive, `to` exclusive), 1-based
   *   `page`, `limit` (already capped at 100), optional `q` substring.
   * @returns The page of session summaries and the full distinct-session count.
   */
  async listSessions(
    teamId: string,
    opts: { from: Date; to: Date; page: number; limit: number; q?: string },
  ): Promise<{ data: SessionSummary[]; total: number }> {
    const qFilter = opts.q
      ? Prisma.sql`AND session_id ILIKE ${'%' + opts.q + '%'}`
      : Prisma.empty;
    const offset = (opts.page - 1) * opts.limit;

    const rows = await prisma.$queryRaw<SessionAggRow[]>(Prisma.sql`
      SELECT
        session_id AS "sessionId",
        COUNT(*)::int AS "traceCount",
        SUM(total_cost_usd)::float8 AS "totalCostUsd",
        COALESCE(SUM(total_tokens), 0)::int AS "totalTokens",
        MIN(started_at) AS "firstAt",
        MAX(started_at) AS "lastAt"
      FROM traces
      WHERE team_id = ${teamId}::uuid
        AND session_id IS NOT NULL
        AND started_at >= ${opts.from}
        AND started_at < ${opts.to}
        ${qFilter}
      GROUP BY session_id
      ORDER BY MAX(started_at) DESC, session_id DESC
      LIMIT ${opts.limit} OFFSET ${offset}
    `);

    const totalRows = await prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT session_id)::int AS "total"
      FROM traces
      WHERE team_id = ${teamId}::uuid
        AND session_id IS NOT NULL
        AND started_at >= ${opts.from}
        AND started_at < ${opts.to}
        ${qFilter}
    `);

    return { data: rows.map((r) => this.toSummary(r)), total: totalRows[0].total };
  }

  /**
   * Fetches one session's summary plus its traces (newest-first, capped at
   * {@link SESSION_TRACES_CAP}). Returns null when the team has no trace with
   * that `session_id` — the caller maps this to a 404.
   *
   * @param teamId - Team scope.
   * @param sessionId - The `session_id` string.
   * @returns `{ session, traces }` or null if unknown for the team.
   */
  async getSession(
    teamId: string,
    sessionId: string,
  ): Promise<{ session: SessionSummary; traces: SessionTraceItem[] } | null> {
    const aggRows = await prisma.$queryRaw<SessionAggRow[]>(Prisma.sql`
      SELECT
        session_id AS "sessionId",
        COUNT(*)::int AS "traceCount",
        SUM(total_cost_usd)::float8 AS "totalCostUsd",
        COALESCE(SUM(total_tokens), 0)::int AS "totalTokens",
        MIN(started_at) AS "firstAt",
        MAX(started_at) AS "lastAt"
      FROM traces
      WHERE team_id = ${teamId}::uuid
        AND session_id = ${sessionId}
      GROUP BY session_id
    `);

    if (aggRows.length === 0) return null;

    const traceRows = await prisma.trace.findMany({
      where: { teamId, sessionId },
      orderBy: { startedAt: 'desc' },
      take: SESSION_TRACES_CAP,
    });

    return {
      session: this.toSummary(aggRows[0]),
      traces: traceRows.map((t) => this.toTraceItem(t)),
    };
  }

  /**
   * Maps a Prisma `Trace` row to the `SessionTraceItem` DTO (Decimal cost →
   * number|null; timestamps → ISO strings).
   *
   * @param t - The Prisma `Trace` row.
   * @returns The trace item for the detail response.
   */
  private toTraceItem(t: Trace): SessionTraceItem {
    return {
      id: t.id,
      name: t.name,
      sessionId: t.sessionId,
      status: t.status,
      startedAt: t.startedAt.toISOString(),
      endedAt: t.endedAt === null ? null : t.endedAt.toISOString(),
      spanCount: t.spanCount,
      totalCostUsd: t.totalCostUsd === null ? null : Number(t.totalCostUsd),
      totalTokens: t.totalTokens,
      tags: t.tags,
    };
  }
}
