import { formatCount, formatUsd } from '../../email/templates/layout';

// Re-exported so the digest's formatting surface — currency, counts, and deltas —
// is one importable module and one unit-test target, even though currency and
// counts are shared with the budget templates and live in the email layout.
export { formatCount, formatUsd };

/**
 * Renders a week-over-week change as a signed percentage.
 *
 * The two undefined cases are handled explicitly rather than arithmetically,
 * because both produce values that must never reach a mail body:
 *
 * - **prior window was zero** → a percentage change from zero is undefined
 *   (`(5-0)/0` is `Infinity`), so this reads `new this week`.
 * - **no change at all** → `+0%` reads like a rounding artifact, so this reads
 *   `no change`. Note this covers `0 → 0` too, which the zero-prior branch would
 *   otherwise label "new this week" for a week with no activity.
 *
 * @param current - This window's value.
 * @param previous - The preceding window's value.
 * @returns A short human phrase, always ending in `vs last week` when it is a
 *   real comparison.
 */
export function formatDelta(current: number, previous: number): string {
  const safeCurrent = Number.isFinite(current) ? current : 0;
  const safePrevious = Number.isFinite(previous) ? previous : 0;

  if (safeCurrent === safePrevious) return 'no change';
  if (safePrevious === 0) return 'new this week';

  const pct = ((safeCurrent - safePrevious) / safePrevious) * 100;
  const rounded = Math.round(pct);

  // A real but tiny change (0.4%) rounds to 0 and would render "+0% vs last
  // week", which contradicts itself. Report the direction instead.
  if (rounded === 0) {
    return `${safeCurrent > safePrevious ? 'slightly up' : 'slightly down'} vs last week`;
  }

  return `${rounded > 0 ? '+' : ''}${rounded}% vs last week`;
}

/**
 * ISO-8601 week identifier for a date, e.g. `2026-W30`.
 *
 * This is what makes the whole schedule safe: the per-team digest job is keyed on
 * it, so a worker restart, a double schedule registration, or a manual
 * re-dispatch cannot send a team two digests for the same week.
 *
 * Implements the real ISO rule (week 1 is the week containing the first Thursday,
 * weeks start Monday) rather than "day-of-year ÷ 7", which drifts and would
 * produce two different keys for one calendar week around New Year.
 *
 * @param date - Any instant. Interpreted in UTC, matching the fixed-UTC schedule.
 * @returns `YYYY-Www`, zero-padded.
 */
export function isoWeekKey(date: Date): string {
  // Shift to the Thursday of this date's ISO week: that Thursday's calendar year
  // is by definition the ISO week-numbering year, which is why this indirection
  // exists instead of using `getUTCFullYear()` directly.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Sunday is 0 in JS, 7 in ISO
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);

  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);

  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Formats a date as the `YYYY-MM-DD` the digest header shows.
 *
 * UTC, and fixed rather than locale-aware: there is no timezone on a team, and a
 * fixed format is assertable in a test on any machine.
 *
 * @param date - The instant to render.
 * @returns e.g. `2026-07-20`.
 */
export function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
