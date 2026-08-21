import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import type { CreateEvalRuleDto, UpdateEvalRuleDto, RuleScoreListQuery } from './online-eval-rule.types';

export interface TodayStats {
  count: number;
  meanScore: number | null;
}

/**
 * Every database query for the online-eval-rule domain: rule CRUD, per-rule
 * daily aggregates, and paginated score listing. No business logic — see
 * `OnlineEvalRuleService` for validation and orchestration.
 */
export class EvalRuleRepository {
  /** @returns The created rule row, with `sampleRate`/`costUsd` as Prisma `Decimal`. */
  create(teamId: string, createdBy: string, input: CreateEvalRuleDto) {
    return prisma.evalRule.create({
      data: {
        teamId,
        createdBy,
        name: input.name,
        criteria: input.criteria,
        judgeModel: input.judgeModel,
        judgePromptId: input.judgePromptId ?? null,
        sampleRate: new Prisma.Decimal(input.sampleRate),
        dailyLimit: input.dailyLimit ?? null,
        alertBelow: input.alertBelow ?? null,
        filter: input.filter as Prisma.InputJsonValue,
        enabled: input.enabled,
      },
    });
  }

  /** @returns The rule, or `undefined` if it does not exist or belongs to another team. */
  async findById(id: string, teamId: string) {
    return (await prisma.evalRule.findFirst({ where: { id, teamId } })) ?? undefined;
  }

  /** @returns Every rule for the team, newest first. */
  list(teamId: string) {
    return prisma.evalRule.findMany({ where: { teamId }, orderBy: { createdAt: 'desc' } });
  }

  /**
   * Every enabled rule across every team, for the worker's 30s in-process
   * cache. Deliberately not team-scoped — the worker fans out over all teams.
   */
  listAllEnabled() {
    return prisma.evalRule.findMany({ where: { enabled: true } });
  }

  /**
   * @returns A map of ruleId → today's (UTC) score count and mean score, for
   * every rule id supplied. Rules with zero scores today are simply absent
   * from the map — callers default to `{ count: 0, meanScore: null }`.
   */
  async getTodayStats(ruleIds: string[], teamId: string): Promise<Map<string, TodayStats>> {
    if (ruleIds.length === 0) return new Map();
    const startOfDayUtc = new Date();
    startOfDayUtc.setUTCHours(0, 0, 0, 0);
    const rows = await prisma.evalRuleScore.groupBy({
      by: ['ruleId'],
      where: { ruleId: { in: ruleIds }, teamId, createdAt: { gte: startOfDayUtc } },
      _count: { _all: true },
      _avg: { score: true },
    });
    const map = new Map<string, TodayStats>();
    for (const row of rows) {
      map.set(row.ruleId, { count: row._count._all, meanScore: row._avg.score });
    }
    return map;
  }

  /** @throws Nothing — returns `undefined` on a cross-team or missing id, same as `findById`. */
  async update(id: string, teamId: string, patch: UpdateEvalRuleDto) {
    const existing = await this.findById(id, teamId);
    if (!existing) return undefined;
    return prisma.evalRule.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.criteria !== undefined ? { criteria: patch.criteria } : {}),
        ...(patch.judgeModel !== undefined ? { judgeModel: patch.judgeModel } : {}),
        ...(patch.judgePromptId !== undefined ? { judgePromptId: patch.judgePromptId } : {}),
        ...(patch.sampleRate !== undefined ? { sampleRate: new Prisma.Decimal(patch.sampleRate) } : {}),
        ...(patch.dailyLimit !== undefined ? { dailyLimit: patch.dailyLimit } : {}),
        ...(patch.alertBelow !== undefined ? { alertBelow: patch.alertBelow } : {}),
        ...(patch.filter !== undefined ? { filter: patch.filter as Prisma.InputJsonValue } : {}),
      },
    });
  }

  /**
   * Sets `enabled: false` directly — used by the worker's budget-exhausted
   * path, which has no HTTP request to go through `update`. `updateMany`
   * (not `update`) because `update`'s `where` only accepts the unique `id`
   * and can't also carry the `teamId` guard.
   */
  async disable(id: string, teamId: string): Promise<void> {
    await prisma.evalRule.updateMany({ where: { id, teamId }, data: { enabled: false } });
  }

  /** @returns `true` if a row existed and was deleted (scores cascade via FK). */
  async remove(id: string, teamId: string): Promise<boolean> {
    const existing = await this.findById(id, teamId);
    if (!existing) return false;
    await prisma.evalRule.delete({ where: { id } });
    return true;
  }

  /** Paginated scores for one rule, optionally bounded by score range. */
  async listScores(ruleId: string, teamId: string, filters: RuleScoreListQuery) {
    const where: Prisma.EvalRuleScoreWhereInput = {
      ruleId,
      teamId,
      ...(filters.minScore !== undefined ? { score: { gte: filters.minScore } } : {}),
      ...(filters.maxScore !== undefined ? { score: { lte: filters.maxScore } } : {}),
    };
    const [total, data] = await Promise.all([
      prisma.evalRuleScore.count({ where }),
      prisma.evalRuleScore.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
    ]);
    return { total, data };
  }

  /** Below-threshold scores for `to-dataset`, newest first, capped at `limit`. */
  scoresBelow(ruleId: string, teamId: string, threshold: number, limit: number) {
    return prisma.evalRuleScore.findMany({
      where: { ruleId, teamId, score: { lt: threshold } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Idempotent write: a retried job or a span delivered twice must produce
   * exactly one row. Relies on the `@@unique([ruleId, spanId])` constraint —
   * a second call with the same pair updates nothing (no-op `update`).
   */
  upsertScore(input: {
    teamId: string;
    ruleId: string;
    traceId: string;
    spanId: string;
    score: number | null;
    passed: boolean | null;
    reason: string | null;
    judgeTraceId: string | null;
    costUsd: number | null;
  }) {
    return prisma.evalRuleScore.upsert({
      where: { ruleId_spanId: { ruleId: input.ruleId, spanId: input.spanId } },
      create: {
        teamId: input.teamId,
        ruleId: input.ruleId,
        traceId: input.traceId,
        spanId: input.spanId,
        score: input.score,
        passed: input.passed,
        reason: input.reason,
        judgeTraceId: input.judgeTraceId,
        costUsd: input.costUsd !== null ? new Prisma.Decimal(input.costUsd) : null,
      },
      update: {},
    });
  }

  /** Count of today's (UTC) scored spans for one rule — the daily-limit check. */
  async countTodayScores(ruleId: string, teamId: string): Promise<number> {
    const startOfDayUtc = new Date();
    startOfDayUtc.setUTCHours(0, 0, 0, 0);
    return prisma.evalRuleScore.count({ where: { ruleId, teamId, createdAt: { gte: startOfDayUtc } } });
  }

  /**
   * @returns `true` if this trace id belongs to a judge call this domain
   * itself produced. Deliberately not team-scoped: `traceId` is a
   * server-generated UUID with no realistic cross-team collision, so a
   * `teamId` param here would add nothing — do not "fix" this for
   * consistency with the other methods above.
   */
  async isJudgeTrace(traceId: string): Promise<boolean> {
    const hit = await prisma.evalRuleScore.findFirst({ where: { judgeTraceId: traceId }, select: { id: true } });
    return hit !== null;
  }

  /**
   * Every rule score recorded against one trace, newest first, with the
   * scoring rule's name attached — used to surface online-eval verdicts
   * inside the trace detail page (mirrors how `FeedbackService` surfaces
   * user feedback there).
   *
   * @param traceId - Internal trace UUID.
   * @param teamId - Team scope.
   * @returns Score rows including `{ rule: { name } }`.
   */
  findByTraceId(traceId: string, teamId: string) {
    return prisma.evalRuleScore.findMany({
      where: { traceId, teamId },
      include: { rule: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }
}
