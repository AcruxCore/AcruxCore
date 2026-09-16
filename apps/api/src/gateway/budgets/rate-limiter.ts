const WINDOW_MS = 60_000;

/** One recorded event in a key's sliding window. */
interface Entry {
  ts: number;     // Date.now() at record time
  tokens: number; // total_tokens attributed to this event (0 at pre-check)
  /**
   * Whether this entry is a request for RPM purposes.
   *
   * `recordTokens` appends a second entry after a call completes, to fold real
   * usage into the TPM window. That entry used to be counted as another request
   * too, so every completed call consumed two RPM slots and a `maxRpm` of 10
   * throttled at 5 — while `x-gateway-ratelimit-remaining` counted down twice as
   * fast. Only the pre-check entry is a request.
   */
  counts: boolean;
}

/**
 * Process-local sliding-window store keyed by virtualKeyId (or teamId for
 * session callers). Not shared across instances — the multi-instance upgrade
 * (Redis) is deferred (open question Q3).
 */
const windows = new Map<string, Entry[]>();

/**
 * How often {@link sweep} is allowed to walk the whole map. One window: any key
 * untouched for that long holds nothing but expired entries.
 */
const SWEEP_INTERVAL_MS = WINDOW_MS;

let lastSweepAt = 0;

/**
 * Drops every key whose newest entry has aged out.
 *
 * Pruning on access cannot do this job, because it only ever runs for the key being
 * used: a team that mints a virtual key per CI job calls each key once, and that key
 * then keeps its map entry for the life of the process. Entries are appended in time
 * order, so the last one is the newest and one comparison per key decides it. Rate
 * limited to once a window, and driven by traffic rather than a timer — a timer would
 * hold the event loop open and have to be torn down in every test suite.
 */
function sweep(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  const cutoff = now - WINDOW_MS;
  for (const [key, entries] of windows) {
    const newest = entries[entries.length - 1];
    if (!newest || newest.ts <= cutoff) windows.delete(key);
  }
}

/**
 * Returns the key's entries that are still inside the trailing 60s window.
 *
 * Deliberately pure: it neither stores nor deletes. An earlier version deleted the
 * key when nothing survived, which made the return value sometimes-live and
 * sometimes-orphaned, so every caller had to remember to store the array back — and
 * a caller that forgot would have had its new entry silently dropped, with no type
 * error to catch it. {@link record} is now the only writer.
 */
function surviving(key: string, now: number): Entry[] {
  const cutoff = now - WINDOW_MS;
  return (windows.get(key) ?? []).filter((e) => e.ts > cutoff);
}

/** The single place a window is written: appends one entry and stores the window. */
function record(key: string, entries: Entry[], entry: Entry): void {
  entries.push(entry);
  windows.set(key, entries);
}

/** Requests (not token records) currently inside the window. */
function requestCount(entries: Entry[]): number {
  return entries.reduce((n, e) => n + (e.counts ? 1 : 0), 0);
}

/** Seconds until the oldest in-window entry ages out (≥ 1). */
function retryAfterSeconds(entries: Entry[], now: number): number {
  if (entries.length === 0) return 1;
  const oldest = entries[0].ts;
  return Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
}

/**
 * Checks the trailing-60s RPM and TPM windows for `key` and, if allowed,
 * records this request (with `tokens` attributed to it). Rejecting does NOT record.
 *
 * @param key - virtualKeyId, or teamId for session callers.
 * @param maxRpm - max requests per 60s; `null`/`undefined` = unlimited.
 * @param maxTpm - max total tokens per 60s; `null`/`undefined` = unlimited.
 * @param tokens - tokens to attribute to this request (0 at pre-check; real usage folded in later via recordTokens).
 * @returns `{ ok, retryAfter?, remaining? }`. `remaining` is RPM headroom after this call (only when maxRpm is set).
 */
export function checkAndRecord(
  key: string,
  maxRpm?: number | null,
  maxTpm?: number | null,
  tokens = 0,
): { ok: boolean; retryAfter?: number; remaining?: number } {
  const now = Date.now();
  sweep(now);
  const entries = surviving(key, now);

  if (maxRpm != null && requestCount(entries) >= maxRpm) {
    return { ok: false, retryAfter: retryAfterSeconds(entries, now) };
  }
  if (maxTpm != null) {
    const tpm = entries.reduce((sum, e) => sum + e.tokens, 0);
    if (tpm >= maxTpm) {
      return { ok: false, retryAfter: retryAfterSeconds(entries, now) };
    }
  }

  record(key, entries, { ts: now, tokens, counts: true });
  const remaining = maxRpm != null ? Math.max(0, maxRpm - requestCount(entries)) : undefined;
  return { ok: true, remaining };
}

/**
 * Attributes real post-call token usage to `key`'s current window as a new
 * entry, so subsequent TPM checks see it. RPM is unaffected (no request counted).
 *
 * @param key - Same key used at pre-check.
 * @param tokens - total_tokens actually consumed by the completed call.
 */
export function recordTokens(key: string, tokens: number): void {
  const now = Date.now();
  sweep(now);
  const entries = surviving(key, now);
  record(key, entries, { ts: now, tokens, counts: false });
}

/** Test-only: clears every window so suites start from a clean counter. */
export function __resetRateLimiter(): void {
  windows.clear();
  lastSweepAt = 0;
}

/** Test-only: how many keys the window store is currently holding. */
export function __rateLimiterKeyCount(): number {
  return windows.size;
}
