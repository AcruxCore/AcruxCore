import { describe, expect, it } from 'vitest';
import { exclusiveEndDate } from './exclusive-end-date';

describe('exclusiveEndDate (issue #840)', () => {
  it('turns a same-day "To" into the next day, so the day itself is included', () => {
    expect(exclusiveEndDate('2026-11-11')).toBe('2026-11-12');
  });

  it('rolls over the end of a month', () => {
    expect(exclusiveEndDate('2026-11-30')).toBe('2026-12-01');
  });

  it('rolls over the end of a year', () => {
    expect(exclusiveEndDate('2026-12-31')).toBe('2027-01-01');
  });

  it('handles a leap day and the day before it', () => {
    expect(exclusiveEndDate('2028-02-28')).toBe('2028-02-29');
    expect(exclusiveEndDate('2028-02-29')).toBe('2028-03-01');
    expect(exclusiveEndDate('2026-02-28')).toBe('2026-03-01');
  });

  it('returns undefined for an empty or malformed value, so the API default applies', () => {
    expect(exclusiveEndDate(undefined)).toBeUndefined();
    expect(exclusiveEndDate('')).toBeUndefined();
    expect(exclusiveEndDate('11/11/2026')).toBeUndefined();
    expect(exclusiveEndDate('2026-02-30')).toBeUndefined();
  });
});
