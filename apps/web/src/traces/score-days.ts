import type { ScoreDay } from '@/api/types';

/**
 * One entry per UTC day from `from` to `to` inclusive, with zero counts on days that had
 * no feedback and no verdicts, so the chart's x axis is time and not "days with data".
 *
 * @param from - First day, `YYYY-MM-DD`.
 * @param to - Last day, `YYYY-MM-DD`.
 * @param days - The days the API returned.
 * @returns A dense, ordered list of days.
 */
export function everyDay(from: string, to: string, days: ScoreDay[]): ScoreDay[] {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const out: ScoreDay[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? { day, up: 0, down: 0, passed: 0, failed: 0 });
  }
  return out;
}
