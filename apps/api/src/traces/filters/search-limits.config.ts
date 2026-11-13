import { positiveIntFromEnv } from '../../shared/env';

/** Default per-statement budget for a trace content search, in milliseconds. */
export const DEFAULT_SEARCH_STATEMENT_TIMEOUT_MS = 5_000;

/** Default number of content searches one team may run at once in one API process. */
export const DEFAULT_SEARCH_MAX_CONCURRENT_PER_TEAM = 3;

/** Resolved bounds for trace content search (`q`). */
export interface SearchLimits {
  /** Postgres `statement_timeout` for each search statement. */
  statementTimeoutMs: number;
  /** Searches one team may have running at once in this process. */
  maxConcurrentPerTeam: number;
}

/**
 * The content-search bounds, read from `TRACE_SEARCH_STATEMENT_TIMEOUT_MS` and
 * `TRACE_SEARCH_MAX_CONCURRENT_PER_TEAM` on every call (not once at load), so an operator
 * or a test can change them without a restart.
 *
 * @returns The bounds, each a positive integer, defaults applied for unset or bad values.
 */
export function getSearchLimits(): SearchLimits {
  return {
    statementTimeoutMs: positiveIntFromEnv('TRACE_SEARCH_STATEMENT_TIMEOUT_MS') ?? DEFAULT_SEARCH_STATEMENT_TIMEOUT_MS,
    maxConcurrentPerTeam:
      positiveIntFromEnv('TRACE_SEARCH_MAX_CONCURRENT_PER_TEAM') ?? DEFAULT_SEARCH_MAX_CONCURRENT_PER_TEAM,
  };
}
