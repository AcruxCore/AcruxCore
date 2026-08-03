import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';

/** A `[from, to)` window. Upper bound exclusive, matching `aggregateUsage`. */
export interface DigestWindow {
  from: Date;
  to: Date;
}

/** Gateway totals over one window. */
export interface DigestUsage {
  requests: number;
  costUsd: number;
}

/** The activity counts a digest reports, all team-scoped and window-bounded. */
export interface DigestCounts {
  traces: number;
  newPrompts: number;
  promptVersions: number;
  runsSucceeded: number;
  runsFailed: number;
}

/** One budget's standing at digest time. */
export interface DigestBudget {
  scope: string;
  period: string;
  spendUsd: number;
  limitUsd: number;
}

/**
 * All database access for the weekly digest. The only file in this feature that
 * touches Prisma.
 *
 * Gateway spend and per-model grouping deliberately reuse the same
 * `gateway_requests` shape `GatewayUsageRepository.aggregateUsage` already
 * queries, rather than a second cost model that could drift from the usage screen
 * the digest links to.
 */
export class DigestRepository {
  /**
   * Finds every team with any activity in the window.
   *
   * A dormant team gets no digest: an empty summary is noise that trains people
   * to ignore the email, and dormant teams are the likeliest to mark it spam.
   *
   * One `UNION` query rather than four round-trips per team — the alternative
   * scales with the number of teams, this scales with the number of active ones.
   * `prompt_versions` has no `team_id` of its own, so it joins through `prompts`.
   *
   * @param window - The activity window.
   * @returns Distinct team ids with at least one gateway request, trace, prompt
   *   version, or experiment run in the window.
   */
  async findActiveTeamIds(window: DigestWindow): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ team_id: string }[]>(Prisma.sql`
      SELECT DISTINCT team_id FROM (
        SELECT team_id FROM gateway_requests
          WHERE created_at >= ${window.from} AND created_at < ${window.to}
        UNION ALL
        SELECT team_id FROM traces
          WHERE started_at >= ${window.from} AND started_at < ${window.to}
        UNION ALL
        SELECT p.team_id FROM prompt_versions pv
          JOIN prompts p ON p.id = pv.prompt_id
          WHERE pv.created_at >= ${window.from} AND pv.created_at < ${window.to}
        UNION ALL
        SELECT team_id FROM experiment_runs
          WHERE created_at >= ${window.from} AND created_at < ${window.to}
      ) activity
    `);
    return rows.map((r) => r.team_id);
  }

  /**
   * Gateway request count and spend for one team over one window.
   *
   * @param teamId - Team scope.
   * @param window - `[from, to)`.
   * @returns Totals, zeroed rather than null when there were no requests.
   */
  async usage(teamId: string, window: DigestWindow): Promise<DigestUsage> {
    const rows = await prisma.$queryRaw<{ requests: number; costUsd: number }[]>(Prisma.sql`
      SELECT
        COUNT(*)::int AS "requests",
        COALESCE(SUM(cost_usd), 0)::float8 AS "costUsd"
      FROM gateway_requests
      WHERE team_id = ${teamId}::uuid
        AND created_at >= ${window.from}
        AND created_at < ${window.to}
    `);
    return rows[0] ?? { requests: 0, costUsd: 0 };
  }

  /**
   * Top models by spend for one team over one window.
   *
   * Ordered and capped in SQL, not in JS: a team with hundreds of registered
   * models should not ship its whole model list to the API process to throw away
   * all but five rows.
   *
   * @param teamId - Team scope.
   * @param window - `[from, to)`.
   * @param limit - Maximum rows (five in the digest).
   * @returns Model name plus spend, highest first.
   */
  async topModels(
    teamId: string,
    window: DigestWindow,
    limit: number,
  ): Promise<{ model: string; costUsd: number; requests: number }[]> {
    return prisma.$queryRaw<{ model: string; costUsd: number; requests: number }[]>(Prisma.sql`
      SELECT
        requested_model AS "model",
        COALESCE(SUM(cost_usd), 0)::float8 AS "costUsd",
        COUNT(*)::int AS "requests"
      FROM gateway_requests
      WHERE team_id = ${teamId}::uuid
        AND created_at >= ${window.from}
        AND created_at < ${window.to}
      GROUP BY requested_model
      ORDER BY "costUsd" DESC, "requests" DESC
      LIMIT ${limit}
    `);
  }

  /**
   * The remaining activity counts, in one round-trip's worth of parallel counts.
   *
   * @param teamId - Team scope.
   * @param window - `[from, to)`.
   * @returns Traces, prompt activity, and terminal run counts.
   */
  async counts(teamId: string, window: DigestWindow): Promise<DigestCounts> {
    const range = { gte: window.from, lt: window.to };

    const [traces, newPrompts, promptVersions, runsSucceeded, runsFailed] = await Promise.all([
      prisma.trace.count({ where: { teamId, startedAt: range } }),
      prisma.prompt.count({ where: { teamId, createdAt: range } }),
      // No `team_id` on `prompt_versions` — scoped through the parent prompt.
      prisma.promptVersion.count({ where: { prompt: { teamId }, createdAt: range } }),
      prisma.experimentRun.count({ where: { teamId, status: 'succeeded', createdAt: range } }),
      prisma.experimentRun.count({ where: { teamId, status: 'failed', createdAt: range } }),
    ]);

    return { traces, newPrompts, promptVersions, runsSucceeded, runsFailed };
  }

  /**
   * Every budget's current standing for a team.
   *
   * Not window-bounded, unlike everything else here: a budget's `spend_usd` is a
   * live running total for its own period, so "current spend against the cap" is
   * the only meaningful reading. Slicing it to the digest window would report a
   * number that matches no screen in the app.
   *
   * @param teamId - Team scope.
   * @returns One entry per budget, team-wide budgets labelled as such.
   */
  async budgets(teamId: string): Promise<DigestBudget[]> {
    const rows = await prisma.budget.findMany({
      where: { teamId },
      select: {
        period: true,
        spendUsd: true,
        limitUsd: true,
        virtualKey: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((b) => ({
      scope: b.virtualKey ? `Key "${b.virtualKey.name}"` : 'Team-wide',
      period: b.period,
      spendUsd: Number(b.spendUsd),
      limitUsd: Number(b.limitUsd),
    }));
  }

  /**
   * Reads a team's display name for the digest heading.
   *
   * @param teamId - The team.
   * @returns The name, or null when the team was deleted between dispatch and send.
   */
  async teamName(teamId: string): Promise<string | null> {
    const row = await prisma.team.findUnique({
      where: { id: teamId },
      select: { name: true },
    });
    return row?.name ?? null;
  }
}
