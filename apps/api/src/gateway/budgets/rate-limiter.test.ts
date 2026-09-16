import { checkAndRecord, recordTokens, __resetRateLimiter, __rateLimiterKeyCount } from './rate-limiter';

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

describe('rate-limiter — recordTokens must not consume RPM (issue #486)', () => {
  beforeEach(() => __resetRateLimiter());

  it('allows the full configured RPM even when every call records tokens', () => {
    // The post-call token record used to be pushed as another window entry, so a
    // completed request consumed two RPM slots and maxRpm=10 throttled at 5.
    for (let i = 1; i <= 10; i++) {
      const res = checkAndRecord('rpm-key', 10, null, 0);
      expect({ call: i, ok: res.ok }).toEqual({ call: i, ok: true });
      recordTokens('rpm-key', 500);
    }
    expect(checkAndRecord('rpm-key', 10, null, 0).ok).toBe(false);
  });

  it('counts remaining headroom down by one per request, not two', () => {
    const seen: (number | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(checkAndRecord('rem-key', 10, null, 0).remaining);
      recordTokens('rem-key', 100);
    }
    expect(seen).toEqual([9, 8, 7, 6]);
  });

  it('still folds recorded tokens into the TPM window', () => {
    expect(checkAndRecord('tpm-key', null, 1000, 0).ok).toBe(true);
    recordTokens('tpm-key', 1500);
    expect(checkAndRecord('tpm-key', null, 1000, 0).ok).toBe(false);
  });
});

describe('rate limiter — the window store does not grow without bound', () => {
  beforeEach(() => __resetRateLimiter());

  it('drops keys that were used once and never came back', () => {
    // The shape that leaked: a key per CI job, each seen exactly once. Pruning on
    // access could never reach them, because access is the only thing that prunes.
    const realNow = Date.now;
    try {
      let clock = realNow();
      Date.now = () => clock;

      for (let i = 0; i < 50; i++) checkAndRecord(`one-shot-key-${i}`, 100, null, 0);
      expect(__rateLimiterKeyCount()).toBe(50);

      // Past the window, and past the sweep interval: one later call from any key
      // is enough to clear every key that has gone quiet.
      clock += 61_000;
      checkAndRecord('a-live-key', 100, null, 0);

      expect(__rateLimiterKeyCount()).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

  it('keeps a key that is still inside its window', () => {
    const realNow = Date.now;
    try {
      let clock = realNow();
      Date.now = () => clock;

      checkAndRecord('busy-key', 100, null, 0);
      clock += 61_000;
      checkAndRecord('busy-key', 100, null, 0); // triggers the sweep, but is itself live
      clock += 1_000;
      checkAndRecord('other-key', 100, null, 0);

      expect(__rateLimiterKeyCount()).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });

  it('records the entry even when the window had just emptied', () => {
    const realNow = Date.now;
    try {
      let clock = realNow();
      Date.now = () => clock;

      checkAndRecord('k', 2, null, 0);
      clock += 61_000; // every entry for 'k' has now aged out, and the sweep drops it
      const first = checkAndRecord('k', 2, null, 0);
      const second = checkAndRecord('k', 2, null, 0);
      const third = checkAndRecord('k', 2, null, 0);
      // The first two refill the emptied window and the third is over the cap —
      // which only holds if the entry written straight after the sweep was stored.
      expect([first.ok, second.ok, third.ok]).toEqual([true, true, false]);
      expect(first.remaining).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });
});
