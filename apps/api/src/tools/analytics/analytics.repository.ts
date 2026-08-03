import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import type { ToolStat } from './analytics.types';

/** Raw shape returned by the grouped aggregate query, before numeric coercion. */
interface RawToolStatRow {
  tool_name: string;
  calls: bigint;
  errors: bigint;
  p50: number | null;
  p95: number | null;
}

/**
 * Read-only aggregation over `tool`-kind spans. This is the only file in the
 * `tools/analytics` domain permitted to import `@prisma/client` — services and
 * controllers must go through this repository.
 */
export class ToolAnalyticsRepository {
  /**
   * Aggregates tool spans by span name (= tool name), team-scoped, over an optional
   * time window. Uses Postgres `percentile_cont` for p50/p95 latency.
   *
   * @param teamId - Team scope; every row read is filtered to `s.team_id = teamId`.
   * @param since - Inclusive lower bound on `s.created_at`, or `null` for no lower bound.
   * @param until - Inclusive upper bound on `s.created_at`, or `null` for no upper bound.
   * @returns One `ToolStat` per distinct tool name that has at least one span in range.
   */
  async statsByTool(teamId: string, since: Date | null, until: Date | null): Promise<ToolStat[]> {
    const sinceClause = since ? Prisma.sql`AND s.created_at >= ${since}` : Prisma.empty;
    const untilClause = until ? Prisma.sql`AND s.created_at <= ${until}` : Prisma.empty;
    const rows = await prisma.$queryRaw<RawToolStatRow[]>`
      SELECT s.name AS tool_name,
             COUNT(*)::bigint AS calls,
             COUNT(*) FILTER (WHERE s.status = 'error')::bigint AS errors,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY s.latency_ms) AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY s.latency_ms) AS p95
      FROM spans s
      WHERE s.team_id = ${teamId}::uuid AND s.kind = 'tool' ${sinceClause} ${untilClause}
      GROUP BY s.name
      ORDER BY calls DESC`;
    return rows.map((r) => {
      const calls = Number(r.calls);
      return {
        toolName: r.tool_name,
        calls,
        errorRate: calls === 0 ? 0 : Number(r.errors) / calls,
        p50Ms: r.p50 === null ? null : Math.round(r.p50),
        p95Ms: r.p95 === null ? null : Math.round(r.p95),
      };
    });
  }
}
