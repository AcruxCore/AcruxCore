import { Prisma } from '@prisma/client';
import { budgetPeriodKey, detectBudgetCrossings, WARNING_FRACTION } from './thresholds';

/** Shorthand for a transition, in dollars. */
function t(before: number, after: number, limit: number) {
  return {
    before: new Prisma.Decimal(before),
    after: new Prisma.Decimal(after),
    limit: new Prisma.Decimal(limit),
  };
}

describe('detectBudgetCrossings', () => {
  it('fires the warning on the request that crosses 80%, and not before', () => {
    expect(detectBudgetCrossings(t(70, 79.99, 100))).toEqual([]);
    expect(detectBudgetCrossings(t(79, 80, 100))).toEqual(['threshold']);
  });

  it('does not fire again on requests that were already past 80%', () => {
    // This is the whole reason detection is on the transition rather than the
    // absolute value: a busy team above 80% would otherwise alert every request.
    expect(detectBudgetCrossings(t(80, 85, 100))).toEqual([]);
    expect(detectBudgetCrossings(t(85, 90, 100))).toEqual([]);
    expect(detectBudgetCrossings(t(90, 99, 100))).toEqual([]);
  });

  it('fires exhausted exactly on the request that reaches the limit', () => {
    expect(detectBudgetCrossings(t(99, 99.99, 100))).toEqual([]);
    expect(detectBudgetCrossings(t(99, 100, 100))).toEqual(['exhausted']);
    expect(detectBudgetCrossings(t(100, 120, 100))).toEqual([]);
  });

  it('fires both when one large request jumps straight past the cap', () => {
    expect(detectBudgetCrossings(t(10, 150, 100))).toEqual(['threshold', 'exhausted']);
  });

  it('uses the configured warning fraction', () => {
    const limit = 50;
    const warnAt = limit * WARNING_FRACTION;
    expect(detectBudgetCrossings(t(warnAt - 0.01, warnAt, limit))).toEqual(['threshold']);
  });

  it('never alerts on a zero or negative cap', () => {
    // `after >= 0` is vacuously true for any spend, so without this guard such a
    // budget would alert on its very first request, forever. A cap of zero means
    // "blocked", which the 402 pre-check already enforces.
    expect(detectBudgetCrossings(t(0, 5, 0))).toEqual([]);
    expect(detectBudgetCrossings(t(0, 5, -1))).toEqual([]);
  });

  it('works at sub-cent precision, where gateway costs actually live', () => {
    // One cheap-model call is ~$0.0000024, and `spend_usd` is Decimal(18,9).
    expect(detectBudgetCrossings(t(0.0000779, 0.0000803, 0.0001))).toEqual(['threshold']);
    expect(detectBudgetCrossings(t(0.0000803, 0.0000827, 0.0001))).toEqual([]);
  });
});

describe('budgetPeriodKey', () => {
  it('changes when the period rolls forward, so the next period alerts again', () => {
    const july = new Date('2026-07-01T00:00:00.000Z');
    const august = new Date('2026-08-01T00:00:00.000Z');
    expect(budgetPeriodKey(july)).not.toBe(budgetPeriodKey(august));
  });

  it('is stable within one period, so concurrent crossings dedupe', () => {
    const resetsAt = new Date('2026-08-01T00:00:00.000Z');
    expect(budgetPeriodKey(resetsAt)).toBe(budgetPeriodKey(new Date(resetsAt)));
  });

  it("collapses a 'total' budget to one key, so it alerts once ever", () => {
    expect(budgetPeriodKey(null)).toBe('total');
  });
});
