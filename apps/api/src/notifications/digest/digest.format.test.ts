import { formatCount, formatDay, formatDelta, formatUsd, isoWeekKey } from './digest.format';

describe('formatUsd', () => {
  it('always shows two decimal places', () => {
    expect(formatUsd(5)).toBe('$5.00');
    expect(formatUsd(5.1)).toBe('$5.10');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('groups thousands', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(1_000_000)).toBe('$1,000,000.00');
  });

  it('rounds sub-cent gateway costs to a readable figure', () => {
    expect(formatUsd(0.0000024)).toBe('$0.00');
    expect(formatUsd(0.126)).toBe('$0.13');
  });

  it('renders a non-finite value as zero rather than $NaN', () => {
    expect(formatUsd(Number.NaN)).toBe('$0.00');
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe('$0.00');
  });
});

describe('formatCount', () => {
  it('groups thousands and rounds', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(12_004)).toBe('12,004');
    expect(formatCount(3.6)).toBe('4');
  });

  it('renders a non-finite value as zero', () => {
    expect(formatCount(Number.NaN)).toBe('0');
  });
});

describe('formatDelta', () => {
  it('renders a signed percentage against the prior window', () => {
    expect(formatDelta(120, 100)).toBe('+20% vs last week');
    expect(formatDelta(80, 100)).toBe('-20% vs last week');
  });

  it('says "no change" rather than +0%', () => {
    expect(formatDelta(100, 100)).toBe('no change');
    // Also covers 0 → 0, which the zero-prior branch would mislabel.
    expect(formatDelta(0, 0)).toBe('no change');
  });

  it('says "new this week" instead of dividing by a zero baseline', () => {
    // The bug this exists to prevent: (5-0)/0 is Infinity, and "Infinity%" ships.
    expect(formatDelta(5, 0)).toBe('new this week');
    expect(formatDelta(0.004, 0)).toBe('new this week');
  });

  it('reports a direction when a real change rounds to 0%', () => {
    expect(formatDelta(100.4, 100)).toBe('slightly up vs last week');
    expect(formatDelta(99.6, 100)).toBe('slightly down vs last week');
  });

  it('never emits NaN or Infinity', () => {
    for (const [a, b] of [
      [Number.NaN, 5],
      [5, Number.NaN],
      [Number.POSITIVE_INFINITY, 0],
      [0, 0],
      [1, 0],
    ] as const) {
      const out = formatDelta(a, b);
      expect(out).not.toMatch(/NaN|Infinity/);
    }
  });
});

describe('isoWeekKey', () => {
  it('is stable across every day of one ISO week', () => {
    // Monday 2026-07-20 through Sunday 2026-07-26.
    const keys = [20, 21, 22, 23, 24, 25, 26].map((d) =>
      isoWeekKey(new Date(`2026-07-${d}T12:00:00.000Z`)),
    );
    expect(new Set(keys).size).toBe(1);
  });

  it('changes on the Monday boundary', () => {
    expect(isoWeekKey(new Date('2026-07-26T23:59:59.000Z'))).not.toBe(
      isoWeekKey(new Date('2026-07-27T00:00:00.000Z')),
    );
  });

  it('zero-pads the week number', () => {
    expect(isoWeekKey(new Date('2026-01-08T00:00:00.000Z'))).toMatch(/^\d{4}-W0\d$/);
  });

  it('uses the ISO week-numbering year across New Year', () => {
    // 2026-12-31 is a Thursday, so it belongs to an ISO week of 2026...
    expect(isoWeekKey(new Date('2026-12-31T00:00:00.000Z'))).toBe('2026-W53');
    // ...and 2027-01-01 (Friday) is in that same ISO week, not 2027-W01.
    expect(isoWeekKey(new Date('2027-01-01T00:00:00.000Z'))).toBe('2026-W53');
    // A naive "day-of-year ÷ 7" would give two different keys for one week here,
    // which would mail two digests for the same seven days.
    expect(isoWeekKey(new Date('2026-12-31T00:00:00.000Z'))).toBe(
      isoWeekKey(new Date('2027-01-01T00:00:00.000Z')),
    );
  });
});

describe('formatDay', () => {
  it('renders UTC YYYY-MM-DD regardless of the machine timezone', () => {
    expect(formatDay(new Date('2026-07-20T23:30:00.000Z'))).toBe('2026-07-20');
  });
});
