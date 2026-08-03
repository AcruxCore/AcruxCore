import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import type { GroupBy, UsageTotals, UsageBucket, RequestListItem } from './usage.types';

/** Filters for the paginated request log. All optional; all narrow the result set. */
interface RequestFilters {
  virtualKeyId?: string;
  model?: string;
  status?: string;
  from?: Date;
  to?: Date;
}

/**
 * Read-only data access over `gateway_requests` for analytics. All queries are
 * team-scoped. Grouped aggregates use raw SQL (`Prisma.sql`) because the
 * date_trunc / dynamic group-by is not expressible in the query builder.
 */
export class UsageRepository {
  /**
   * Maps a group-by dimension to a safe SQL expression fragment. The `groupBy`
   * value is a validated enum, never raw user input, so the fragment is safe.
   *
   * @param groupBy - Validated grouping dimension.
   * @returns A Prisma.Sql fragment used both in SELECT and GROUP BY.
   */
  private groupExpr(groupBy: GroupBy): Prisma.Sql {
    switch (groupBy) {
      case 'day':
        return Prisma.sql`to_char(date_trunc('day', created_at), 'YYYY-MM-DD')`;
      case 'model':
        return Prisma.sql`COALESCE(resolved_model, requested_model)`;
      case 'virtual_key':
        return Prisma.sql`virtual_key_id::text`;
      case 'provider':
        return Prisma.sql`COALESCE(provider, 'unknown')`;
    }
  }

  /**
   * Aggregates spend/tokens/rates over a date range, plus grouped buckets.
   * `created_at` window is `[from, to)` (upper bound exclusive). Rows whose
   * group key is NULL (e.g. calls with no virtual key when grouping by
   * virtual_key) are omitted from the buckets.
   *
   * @param teamId - Team scope.
   * @param from - Inclusive lower bound on created_at.
   * @param to - Exclusive upper bound on created_at.
   * @param groupBy - Bucket dimension.
   * @param virtualKeyId - Optional filter to a single virtual key.
   * @returns Totals across the range and one bucket per group key.
   */
  async aggregateUsage(
    teamId: string,
    from: Date,
    to: Date,
    groupBy: GroupBy,
    virtualKeyId?: string,
  ): Promise<{ totals: UsageTotals; buckets: UsageBucket[] }> {
    const vkFilter = virtualKeyId
      ? Prisma.sql`AND virtual_key_id = ${virtualKeyId}::uuid`
      : Prisma.empty;

    const totalsRows = await prisma.$queryRaw<UsageTotals[]>(Prisma.sql`
      SELECT
        COUNT(*)::int AS "requests",
        COALESCE(SUM(prompt_tokens), 0)::float8 AS "promptTokens",
        COALESCE(SUM(completion_tokens), 0)::float8 AS "completionTokens",
        COALESCE(SUM(cost_usd), 0)::float8 AS "costUsd",
        COALESCE(AVG(CASE WHEN cache_hit THEN 1 ELSE 0 END), 0)::float8 AS "cacheHitRate",
        COALESCE(AVG(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0)::float8 AS "errorRate"
      FROM gateway_requests
      WHERE team_id = ${teamId}::uuid
        AND created_at >= ${from}
        AND created_at < ${to}
        ${vkFilter}
    `);

    const buckets = await prisma.$queryRaw<UsageBucket[]>(Prisma.sql`
      SELECT
        ${this.groupExpr(groupBy)} AS "key",
        COUNT(*)::int AS "requests",
        COALESCE(SUM(prompt_tokens), 0)::float8 AS "promptTokens",
        COALESCE(SUM(completion_tokens), 0)::float8 AS "completionTokens",
        COALESCE(SUM(cost_usd), 0)::float8 AS "costUsd"
      FROM gateway_requests
      WHERE team_id = ${teamId}::uuid
        AND created_at >= ${from}
        AND created_at < ${to}
        ${vkFilter}
      GROUP BY 1
      ORDER BY 1
    `);

    return {
      totals: totalsRows[0],
      buckets: buckets.filter((b) => b.key !== null),
    };
  }

  /**
   * Returns a paginated, newest-first slice of the request log plus the full count.
   *
   * @param teamId - Team scope.
   * @param filters - Optional narrowing filters.
   * @param page - 1-based page.
   * @param limit - Page size (already capped upstream at 100).
   * @returns Mapped rows and the total matching count.
   */
  async listRequests(
    teamId: string,
    filters: RequestFilters,
    page: number,
    limit: number,
  ): Promise<{ rows: RequestListItem[]; total: number }> {
    const where: Prisma.GatewayRequestWhereInput = {
      teamId,
      ...(filters.virtualKeyId ? { virtualKeyId: filters.virtualKeyId } : {}),
      ...(filters.model
        ? { OR: [{ requestedModel: filters.model }, { resolvedModel: filters.model }] }
        : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.from || filters.to
        ? {
            createdAt: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lt: filters.to } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.gatewayRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: (page - 1) * limit,
      }),
      prisma.gatewayRequest.count({ where }),
    ]);

    return { rows: rows.map((r) => this.toItem(r)), total };
  }

  /**
   * Fetches one request row by id, scoped to the team.
   *
   * @param teamId - Team scope.
   * @param id - Request row id.
   * @returns The mapped row, or null if not found in this team.
   */
  async getRequest(teamId: string, id: string): Promise<RequestListItem | null> {
    const r = await prisma.gatewayRequest.findFirst({ where: { id, teamId } });
    return r ? this.toItem(r) : null;
  }

  /** Maps a Prisma GatewayRequest row to the API DTO (Decimal cost → number|null). */
  private toItem(r: {
    id: string;
    createdAt: Date;
    virtualKeyId: string | null;
    provider: string | null;
    requestedModel: string;
    resolvedModel: string | null;
    status: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: Prisma.Decimal | null;
    latencyMs: number | null;
    cacheHit: boolean;
    promptVersionId: string | null;
    errorCode: string | null;
  }): RequestListItem {
    return {
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      virtualKeyId: r.virtualKeyId,
      provider: r.provider,
      requestedModel: r.requestedModel,
      resolvedModel: r.resolvedModel,
      status: r.status,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      costUsd: r.costUsd === null ? null : Number(r.costUsd),
      latencyMs: r.latencyMs,
      cacheHit: r.cacheHit,
      promptVersionId: r.promptVersionId,
      errorCode: r.errorCode,
    };
  }
}
