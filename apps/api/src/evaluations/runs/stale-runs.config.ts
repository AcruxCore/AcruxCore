/** Default sweep schedule: every 10 minutes. */
export const DEFAULT_STALE_RUN_CRON = '*/10 * * * *';

/**
 * Default idle time, in minutes, before a run counts as stale. Two hours is far
 * beyond any healthy gap between two results of one run (a cell is one model
 * call), yet short enough that a lost run is reported the same day.
 */
export const DEFAULT_STALE_RUN_MINUTES = 120;

/**
 * Sanity floor for `EVAL_STALE_RUN_MINUTES`. A smaller window would fail runs
 * that are only waiting behind a busy queue, so anything below it is treated
 * as a misconfiguration.
 */
export const MIN_STALE_RUN_MINUTES = 10;

/** Resolved stale-run sweep configuration. */
export interface StaleRunConfig {
  /** Whether the repeatable sweep job is registered at all. */
  enabled: boolean;
  /** Minutes without progress before a `queued`/`running` run is failed. */
  staleMinutes: number;
  /** Cron pattern, interpreted in UTC. */
  cron: string;
}

/**
 * Parses `EVAL_STALE_RUN_MINUTES`, falling back to the default for anything that
 * is not a whole number at or above {@link MIN_STALE_RUN_MINUTES}. An empty
 * string deliberately warns instead of defaulting quietly: `Number('')` is `0`,
 * which would fail every run that has not written a result in the last second.
 */
function parseStaleMinutes(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_STALE_RUN_MINUTES;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_STALE_RUN_MINUTES) {
    console.warn(
      `[stale-runs] EVAL_STALE_RUN_MINUTES="${raw}" is not a whole number of at least ` +
        `${MIN_STALE_RUN_MINUTES}. Falling back to ${DEFAULT_STALE_RUN_MINUTES} minutes so that ` +
        'runs waiting in a busy queue are not failed by mistake.',
    );
    return DEFAULT_STALE_RUN_MINUTES;
  }
  return parsed;
}

/**
 * Reads the stale-run sweep settings from the environment.
 *
 * `EVAL_STALE_RUN_REAPER_ENABLED` defaults to **true in every environment**: the
 * sweep only moves a run that is already dead to `failed`, so it is safe to run
 * locally, and a user who is waiting on a run needs it in production most. Set it
 * to `false` to stop the schedule on the next worker restart without a deploy.
 *
 * @returns The resolved config. Never throws; a malformed cron is BullMQ's to
 *   reject at registration, where the error names the pattern.
 */
export function loadStaleRunConfig(): StaleRunConfig {
  return {
    enabled: process.env.EVAL_STALE_RUN_REAPER_ENABLED !== 'false',
    staleMinutes: parseStaleMinutes(process.env.EVAL_STALE_RUN_MINUTES),
    cron: process.env.EVAL_STALE_RUN_CRON || DEFAULT_STALE_RUN_CRON,
  };
}
