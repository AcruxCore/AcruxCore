const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The exclusive API end for an inclusive "To" date the user picked. The analytics
 * endpoints treat `to` as exclusive (`started_at < to`), but a person reads "To 11 Nov"
 * as "through 11 Nov", so the page sends the following day instead.
 *
 * The math is done on the calendar date in UTC, never through the browser's local
 * timezone, so a `YYYY-MM-DD` value cannot shift by a day in a UTC+N or UTC-N browser.
 *
 * @param date - A `YYYY-MM-DD` string from `<input type="date">`, or undefined.
 * @returns The next calendar day as `YYYY-MM-DD` (month, year and leap-day rollover
 *   included), or undefined when `date` is empty, not `YYYY-MM-DD`, or not a real
 *   calendar date (e.g. `2026-02-30`), so the API's own default end applies.
 */
export function exclusiveEndDate(date: string | undefined): string | undefined {
  const match = date ? DATE_ONLY.exec(date) : null;
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const picked = new Date(Date.UTC(year, month, day));
  if (picked.getUTCFullYear() !== year || picked.getUTCMonth() !== month || picked.getUTCDate() !== day) {
    return undefined;
  }
  return new Date(Date.UTC(year, month, day + 1)).toISOString().slice(0, 10);
}
