import type { BudgetPeriod } from '../../shared/db/schema';

/**
 * Computes the moment a budget of the given period next resets, in UTC.
 *
 * - `day`   → the next UTC midnight (00:00:00) strictly after `from`.
 * - `week`  → the next Monday 00:00:00 UTC strictly after `from`.
 * - `month` → the 1st of the next month at 00:00:00 UTC.
 * - `total` → `null` (this budget never resets).
 *
 * @param period - The budget's reset cadence.
 * @param from - The reference instant (usually "now" or the budget's createdAt).
 * @returns The next reset instant, or `null` for a `total` budget.
 */
export function computeResetsAt(period: BudgetPeriod, from: Date): Date | null {
  switch (period) {
    case 'day': {
      return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1, 0, 0, 0, 0));
    }
    case 'week': {
      // getUTCDay(): Sun=0..Sat=6. Days until the next Monday (1), always ≥ 1.
      const dow = from.getUTCDay();
      const daysUntilMonday = ((8 - dow) % 7) || 7;
      return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + daysUntilMonday, 0, 0, 0, 0));
    }
    case 'month': {
      return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1, 0, 0, 0, 0));
    }
    case 'total':
      return null;
  }
}
