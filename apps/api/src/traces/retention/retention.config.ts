/** Default schedule: daily at 03:00 UTC. */
export const DEFAULT_PURGE_CRON = '0 3 * * *';

/** Default retention window, in days, for captured span payload content. */
export const DEFAULT_RETENTION_DAYS = 90;

/**
 * Sanity floor for `TRACE_PAYLOAD_RETENTION_DAYS`. A cutoff below this is
 * almost certainly a misconfiguration (an empty string, a typo, or a stray
 * `0`) rather than an intentional near-instant purge, and the blast radius of
 * accepting it is deleting every team's captured payload content in one
 * sweep. Reject anything under this and fall back to the default instead.
 */
export const MIN_RETENTION_DAYS = 1;

/** Resolved payload-purge scheduling configuration. */
export interface RetentionConfig {
  /** Whether the repeatable purge job is registered at all. */
  enabled: boolean;
  /** How many days of `span_payloads` content to retain. */
  retentionDays: number;
  /** Cron pattern, interpreted in UTC. */
  cron: string;
}

/**
 * Parses and validates `TRACE_PAYLOAD_RETENTION_DAYS`, falling back to
 * `DEFAULT_RETENTION_DAYS` for any value that isn't a safe, positive,
 * whole number of days.
 *
 * This exists because `Number(process.env.X)` alone is unsafe for a
 * destructive-purge cutoff: an empty string (`""` — some deployment tooling
 * exports this instead of unsetting a var) is not `null`/`undefined`, so a
 * `?? DEFAULT` fallback never triggers, and `Number('')` evaluates to `0` —
 * a `0`-day retention window means "delete everything older than right
 * now," which would wipe every team's payload data on the next scheduled
 * purge. A non-numeric typo produces `NaN`, which would make the purge job
 * throw indefinitely instead of purging. Both cases are logged loudly and
 * replaced with the documented default rather than silently accepted.
 *
 * @param raw - The raw `TRACE_PAYLOAD_RETENTION_DAYS` env value, if set.
 * @returns A validated, positive, finite integer number of days.
 */
function parseRetentionDays(raw: string | undefined): number {
  // Genuinely unset (the env var was never provided at all) is the normal,
  // expected default path — NOT a misconfiguration — so it returns quietly.
  // An empty string, by contrast, deliberately does NOT take this early
  // return: it falls through to `Number('')` below, which evaluates to `0`
  // and is caught by the same "too small" check as any other invalid value,
  // so it warns rather than silently defaulting — surfacing the exact
  // deployment-tooling footgun this fix exists for.
  if (raw === undefined) {
    return DEFAULT_RETENTION_DAYS;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < MIN_RETENTION_DAYS) {
    console.warn(
      `[trace-retention] TRACE_PAYLOAD_RETENTION_DAYS="${raw}" is not a valid positive integer ` +
        `(minimum ${MIN_RETENTION_DAYS} day). Falling back to the default of ${DEFAULT_RETENTION_DAYS} ` +
        'days to avoid purging span payload data with an unsafe cutoff.',
    );
    return DEFAULT_RETENTION_DAYS;
  }

  return parsed;
}

/**
 * Reads the payload-purge schedule from the environment (Finding #7).
 *
 * `TRACE_PAYLOAD_PURGE_ENABLED` defaults to **false outside production**, mirroring
 * the digest schedule's kill switch: a developer running the worker locally must
 * not have a scheduled job quietly deleting rows from a copy of the production
 * database. It is a kill switch rather than a code path — setting it to `false`
 * in production stops the schedule on the next worker restart without a deploy.
 *
 * @returns The resolved config. Never throws — a malformed cron is BullMQ's to
 *   reject at registration, where the error names the actual pattern; a
 *   malformed retention window falls back to the safe default instead (see
 *   {@link parseRetentionDays}).
 */
export function loadRetentionConfig(): RetentionConfig {
  const raw = process.env.TRACE_PAYLOAD_PURGE_ENABLED;
  const enabled = raw === undefined ? process.env.NODE_ENV === 'production' : raw === 'true';

  return {
    enabled,
    retentionDays: parseRetentionDays(process.env.TRACE_PAYLOAD_RETENTION_DAYS),
    cron: process.env.TRACE_PAYLOAD_PURGE_CRON || DEFAULT_PURGE_CRON,
  };
}
