const WINDOW_MS = 60_000;

/** One recorded event in a key's sliding window. */
interface Entry {
  ts: number;     // Date.now() at record time
  tokens: number; // total_tokens attributed to this event (0 at pre-check)
}

/**
 * Process-local sliding-window store keyed by virtualKeyId (or teamId for
 * session callers). Not shared across instances — the multi-instance upgrade
 * (Redis) is deferred (open question Q3).
 */
const windows = new Map<string, Entry[]>();

/** Drops entries older than the trailing 60s window and returns the survivors. */
function prune(key: string, now: number): Entry[] {
  const cutoff = now - WINDOW_MS;
  const kept = (windows.get(key) ?? []).filter((e) => e.ts > cutoff);
  windows.set(key, kept);
  return kept;
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
  const entries = prune(key, now);

  if (maxRpm != null && entries.length >= maxRpm) {
    return { ok: false, retryAfter: retryAfterSeconds(entries, now) };
  }
  if (maxTpm != null) {
    const tpm = entries.reduce((sum, e) => sum + e.tokens, 0);
    if (tpm >= maxTpm) {
      return { ok: false, retryAfter: retryAfterSeconds(entries, now) };
    }
  }

  entries.push({ ts: now, tokens });
  const remaining = maxRpm != null ? Math.max(0, maxRpm - entries.length) : undefined;
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
  const entries = prune(key, now);
  entries.push({ ts: now, tokens });
}

/** Test-only: clears every window so suites start from a clean counter. */
export function __resetRateLimiter(): void {
  windows.clear();
}
