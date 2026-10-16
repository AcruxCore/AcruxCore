import { describe, expect, it } from 'vitest';
import { everyDay } from './score-days';

describe('everyDay', () => {
  it('fills every day of the window, keeping the counts of days the API returned', () => {
    const days = everyDay('2026-10-04', '2026-10-07', [
      { day: '2026-10-05', up: 1, down: 0, passed: 6, failed: 11 },
    ]);
    expect(days.map((d) => d.day)).toEqual(['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
    expect(days[1]).toEqual({ day: '2026-10-05', up: 1, down: 0, passed: 6, failed: 11 });
    expect(days[2]).toEqual({ day: '2026-10-06', up: 0, down: 0, passed: 0, failed: 0 });
  });

  it('crosses a month end without skipping or repeating a day', () => {
    expect(everyDay('2026-10-30', '2026-11-02', []).map((d) => d.day)).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });
});
