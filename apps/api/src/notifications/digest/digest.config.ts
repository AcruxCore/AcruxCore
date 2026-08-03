/** Default schedule: Mondays 08:00 UTC. */
export const DEFAULT_DIGEST_CRON = '0 8 * * 1';

/** How many models the digest lists. */
export const TOP_MODELS_LIMIT = 5;

/** Length of the digest window, in days. */
export const DIGEST_WINDOW_DAYS = 7;

/** Resolved digest scheduling configuration. */
export interface DigestConfig {
  /** Whether the repeatable job is registered at all. */
  enabled: boolean;
  /** Cron pattern, interpreted in UTC. */
  cron: string;
}

/**
 * Reads the digest schedule from the environment.
 *
 * `DIGEST_ENABLED` defaults to **false outside production**. A developer running
 * the worker locally must not have a weekly job firing against a copy of the
 * production database — and, since `EMAIL_TRANSPORT` falls back to `memory`
 * outside production, a stray local run would silently produce nothing anyway,
 * which is worse than not running.
 *
 * It is a kill switch rather than a code path: setting it to `false` in
 * production stops the schedule on the next worker restart without a deploy.
 *
 * @returns The resolved config. Never throws — a malformed cron is BullMQ's to
 *   reject at registration, where the error names the actual pattern.
 */
export function loadDigestConfig(): DigestConfig {
  const raw = process.env.DIGEST_ENABLED;
  const enabled =
    raw === undefined ? process.env.NODE_ENV === 'production' : raw === 'true';

  return {
    enabled,
    cron: process.env.DIGEST_CRON || DEFAULT_DIGEST_CRON,
  };
}
