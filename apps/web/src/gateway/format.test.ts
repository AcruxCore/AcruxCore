import { describe, expect, it } from 'vitest';
import { formatLatency } from './format';

describe('formatLatency', () => {
  it('rounds a fractional sub-second percentile to whole milliseconds', () => {
    // Postgres `percentile_cont` interpolates, so p95 of [950, 1010] is 980.0999999999999.
    expect(formatLatency(980.0999999999999)).toBe('980ms');
    expect(formatLatency(723.5)).toBe('724ms');
  });

  it('keeps whole milliseconds, seconds and the missing value as they were', () => {
    expect(formatLatency(42)).toBe('42ms');
    expect(formatLatency(1234)).toBe('1.23s');
    expect(formatLatency(null)).toBe('—');
  });

  it('shows 999.6ms as 1.00s rather than a 1000ms label', () => {
    expect(formatLatency(999.6)).toBe('1.00s');
  });
});
