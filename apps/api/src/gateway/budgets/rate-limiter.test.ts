import { checkAndRecord, recordTokens, __resetRateLimiter } from './rate-limiter';

describe('rate-limiter (in-memory sliding window)', () => {
  beforeEach(() => __resetRateLimiter());
  afterEach(() => jest.useRealTimers());

  it('RPM trips on the 2nd call when maxRpm=1', () => {
    const first = checkAndRecord('k1', 1, null, 0);
    expect(first.ok).toBe(true);
    expect(first.remaining).toBe(0);

    const second = checkAndRecord('k1', 1, null, 0);
    expect(second.ok).toBe(false);
    expect(second.retryAfter).toBeGreaterThan(0);
    expect(second.retryAfter).toBeLessThanOrEqual(60);
  });

  it('null maxRpm and null maxTpm = unlimited (never trips)', () => {
    for (let i = 0; i < 100; i++) {
      expect(checkAndRecord('k2', null, null, 999999).ok).toBe(true);
    }
  });

  it('window expiry: after 60s the earlier request no longer counts', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-03T00:00:00.000Z'));
    expect(checkAndRecord('k3', 1, null, 0).ok).toBe(true);
    expect(checkAndRecord('k3', 1, null, 0).ok).toBe(false); // within the minute

    jest.setSystemTime(new Date('2026-07-03T00:01:01.000Z')); // 61s later
    expect(checkAndRecord('k3', 1, null, 0).ok).toBe(true);   // window cleared
  });

  it('TPM trips once the trailing-60s token sum reaches maxTpm', () => {
    // maxTpm=100. Two 60-token calls sum to 120, tripping the third.
    expect(checkAndRecord('k4', null, 100, 60).ok).toBe(true); // sum 0 < 100 → record 60
    expect(checkAndRecord('k4', null, 100, 60).ok).toBe(true); // sum 60 < 100 → record 60 (=120)
    const third = checkAndRecord('k4', null, 100, 0);
    expect(third.ok).toBe(false);                              // sum 120 ≥ 100
    expect(third.retryAfter).toBeGreaterThan(0);
  });

  it('recordTokens folds post-call usage into the window (later TPM check sees it)', () => {
    expect(checkAndRecord('k5', null, 100, 0).ok).toBe(true); // record request, 0 tokens
    recordTokens('k5', 150);                                  // real usage arrives after the call
    expect(checkAndRecord('k5', null, 100, 0).ok).toBe(false); // sum 150 ≥ 100
  });

  it('a rejected call is NOT recorded (does not deepen the window)', () => {
    checkAndRecord('k6', 1, null, 0);            // ok, count=1
    checkAndRecord('k6', 1, null, 0);            // rejected
    checkAndRecord('k6', 1, null, 0);            // still rejected; count stayed 1, not 3
    // Raising the limit to 2 immediately allows exactly one more.
    expect(checkAndRecord('k6', 2, null, 0).ok).toBe(true);
    expect(checkAndRecord('k6', 2, null, 0).ok).toBe(false);
  });
});
