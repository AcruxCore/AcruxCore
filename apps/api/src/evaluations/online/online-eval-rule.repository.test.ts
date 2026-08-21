import { randomUUID } from 'node:crypto';
import prisma from '../../shared/db/client';
import { EvalRuleRepository } from './online-eval-rule.repository';

const repo = new EvalRuleRepository();

async function truncate(): Promise<void> {
  await prisma.$executeRaw`TRUNCATE TABLE eval_rule_scores, eval_rules, teams, users RESTART IDENTITY CASCADE`;
}

async function seedTeam(): Promise<{ teamId: string; userId: string }> {
  const team = await prisma.team.create({ data: { name: 'Online Eval Team' } });
  const user = await prisma.user.create({
    data: { email: `u_${Math.floor(Math.random() * 1e9)}@example.com` },
  });
  return { teamId: team.id, userId: user.id };
}

beforeEach(truncate);
afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
});

describe('EvalRuleRepository.create + findById', () => {
  it('creates a rule scoped to its team and is invisible to another team', async () => {
    const { teamId, userId } = await seedTeam();
    const other = await seedTeam();

    const rule = await repo.create(teamId, userId, {
      name: 'quality gate',
      criteria: 'the reply must answer the question asked',
      judgeModel: 'gpt-4o-mini',
      sampleRate: 0.5,
      dailyLimit: 100,
      alertBelow: 50,
      filter: {},
      enabled: true,
    });

    expect(rule.teamId).toBe(teamId);
    // Prisma's Decimal (decimal.js) normalizes away trailing zeros on
    // toString() regardless of the column's numeric(4,3) scale, so the
    // round-tripped value reads back as '0.5', not '0.500'.
    expect(rule.sampleRate.toString()).toBe('0.5');

    const found = await repo.findById(rule.id, teamId);
    expect(found?.id).toBe(rule.id);

    const notFound = await repo.findById(rule.id, other.teamId);
    expect(notFound).toBeUndefined();
  });
});

describe('EvalRuleRepository team-scoping on disable/getTodayStats/countTodayScores', () => {
  it('disable() is a no-op for another team and only takes effect for the owning team', async () => {
    const { teamId, userId } = await seedTeam();
    const other = await seedTeam();

    const rule = await repo.create(teamId, userId, {
      name: 'quality gate',
      criteria: 'the reply must answer the question asked',
      judgeModel: 'gpt-4o-mini',
      sampleRate: 0.5,
      dailyLimit: 100,
      alertBelow: 50,
      filter: {},
      enabled: true,
    });

    await repo.disable(rule.id, other.teamId);
    const stillEnabled = await repo.findById(rule.id, teamId);
    expect(stillEnabled?.enabled).toBe(true);

    await repo.disable(rule.id, teamId);
    const nowDisabled = await repo.findById(rule.id, teamId);
    expect(nowDisabled?.enabled).toBe(false);
  });

  it('getTodayStats() and countTodayScores() only count a rule\'s scores under its own team', async () => {
    const { teamId, userId } = await seedTeam();
    const other = await seedTeam();

    const rule = await repo.create(teamId, userId, {
      name: 'quality gate',
      criteria: 'the reply must answer the question asked',
      judgeModel: 'gpt-4o-mini',
      sampleRate: 0.5,
      dailyLimit: 100,
      alertBelow: 50,
      filter: {},
      enabled: true,
    });

    await repo.upsertScore({
      teamId,
      ruleId: rule.id,
      traceId: randomUUID(),
      spanId: randomUUID(),
      score: 80,
      passed: true,
      reason: null,
      judgeTraceId: null,
      costUsd: null,
    });

    const statsForOwningTeam = await repo.getTodayStats([rule.id], teamId);
    expect(statsForOwningTeam.get(rule.id)).toEqual({ count: 1, meanScore: 80 });

    const statsForOtherTeam = await repo.getTodayStats([rule.id], other.teamId);
    expect(statsForOtherTeam.get(rule.id)).toBeUndefined();

    expect(await repo.countTodayScores(rule.id, teamId)).toBe(1);
    expect(await repo.countTodayScores(rule.id, other.teamId)).toBe(0);
  });
});
