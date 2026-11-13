import type { Prisma } from '@prisma/client';
import { isStatementTimeout, runWithStatementTimeout } from '../../shared/db/statement-timeout';
import { SearchTimeoutError } from '../../shared/errors';
import { withTeamSearchSlot } from './search-concurrency';
import { getSearchLimits } from './search-limits.config';

/**
 * Runs the queries of one trace content search (`q`) within its bounds: at most a few at
 * once per team, and each statement stopped by Postgres at the configured timeout.
 *
 * A content search is `ILIKE '%q%'` over captured payloads, which no index serves, so one
 * search can hold a pooled connection for seconds and a burst of them can take the whole
 * pool from every other team. Every surface that searches trace content (the trace list,
 * the feedback feed, the dataset builders) runs its search statements through this.
 *
 * @param teamId - The team searching; its concurrent searches are counted together.
 * @param fn - The search statements; each must use the given transaction client.
 * @returns Whatever `fn` returns.
 * @throws {RateLimitedError} 429 when the team already has its limit of searches running.
 * @throws {SearchTimeoutError} 422 when a statement runs past the timeout.
 */
export function runContentSearch<T>(teamId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const limits = getSearchLimits();
  return withTeamSearchSlot(teamId, limits.maxConcurrentPerTeam, async () => {
    try {
      return await runWithStatementTimeout(limits.statementTimeoutMs, fn);
    } catch (err) {
      if (isStatementTimeout(err)) throw new SearchTimeoutError();
      throw err;
    }
  });
}
