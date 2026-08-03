import { Prisma } from '@prisma/client';

/** Fraction of a budget's cap that triggers the early warning. Fixed, per spec B §4. */
export const WARNING_FRACTION = 0.8;

/** Which alert a crossing produced. */
export type BudgetCrossing = 'threshold' | 'exhausted';

/** A budget's spend before and after one increment, plus its cap. */
export interface SpendTransition {
  /** `spend_usd` before the increment. */
  before: Prisma.Decimal;
  /** `spend_usd` after the increment, as returned by the UPDATE. */
  after: Prisma.Decimal;
  /** `limit_usd`. */
  limit: Prisma.Decimal;
}

/**
 * Decides which budget alerts one spend increment crossed.
 *
 * Detection lives here — on the transition — rather than on the absolute value,
 * because `precheckBudgets` runs on *every* gateway call: a busy team sitting
 * above 80% would otherwise generate an alert per request. A crossing is
 * `before < threshold && after >= threshold`, which is true exactly once per
 * period, for whichever request pushed it over.
 *
 * Both alerts can fire on the same increment — one large request can take a
 * budget from 10% straight past the cap — and the caller sends both, because
 * "you are near the limit" and "you are cut off" are different facts.
 *
 * A zero or negative `limit` yields no crossings at all: `after >= 0` is
 * vacuously true for any spend, so such a budget would alert on its very first
 * request forever. A cap of zero means "blocked", which `precheckBudgets`
 * already enforces as a 402; it is not a threshold to warn about.
 *
 * @param t - Spend before and after the increment, and the cap.
 * @returns The crossings this increment caused, in escalating order.
 */
export function detectBudgetCrossings(t: SpendTransition): BudgetCrossing[] {
  if (t.limit.lte(0)) return [];

  const warnAt = t.limit.mul(WARNING_FRACTION);
  const crossings: BudgetCrossing[] = [];

  if (t.before.lt(warnAt) && t.after.gte(warnAt)) crossings.push('threshold');
  if (t.before.lt(t.limit) && t.after.gte(t.limit)) crossings.push('exhausted');

  return crossings;
}

/**
 * A stable identifier for the budget period a crossing happened in.
 *
 * Keyed on `resets_at` — the moment the period ends — which identifies the
 * period exactly as well as its start would, without re-deriving the period
 * arithmetic that `computeResetsAt` already owns. When it rolls forward, the next
 * period gets a different key and legitimately alerts again.
 *
 * @param resetsAt - The budget's `resets_at`, or null for a `total` budget.
 * @returns The ISO instant, or `total` for a budget that never resets — which
 *   therefore alerts once, ever.
 */
export function budgetPeriodKey(resetsAt: Date | null): string {
  return resetsAt ? resetsAt.toISOString() : 'total';
}
