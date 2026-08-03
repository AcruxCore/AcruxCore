import { describe, expect, it } from 'vitest';
import { presetFrom } from './date-range';

describe('presetFrom', () => {
  const now = new Date('2026-07-15T09:30:00Z');

  it('7d/30d/90d subtract whole days from now, in UTC', () => {
    expect(presetFrom('7d', now)).toBe('2026-07-08');
    expect(presetFrom('30d', now)).toBe('2026-06-15');
    expect(presetFrom('90d', now)).toBe('2026-04-16');
  });

  it('mtd anchors to the 1st of the current UTC month', () => {
    expect(presetFrom('mtd', now)).toBe('2026-07-01');
  });

  it('ytd anchors to Jan 1st of the current UTC year', () => {
    expect(presetFrom('ytd', now)).toBe('2026-01-01');
  });

  it('mtd/ytd on the 1st of January are both Jan 1st', () => {
    const newYearsDay = new Date('2026-01-01T00:00:00Z');
    expect(presetFrom('mtd', newYearsDay)).toBe('2026-01-01');
    expect(presetFrom('ytd', newYearsDay)).toBe('2026-01-01');
  });

  it('custom has no computed from', () => {
    expect(presetFrom('custom', now)).toBeNull();
  });
});
