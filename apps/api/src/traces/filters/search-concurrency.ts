import { RateLimitedError } from '../../shared/errors';

/** Content searches running now in this process, per team. A team with none has no key. */
const running = new Map<string, number>();

/**
 * Runs `fn` if the team has fewer than `max` content searches running, else refuses it.
 *
 * The cap protects this process's database connection pool, which every team shares: each
 * running search holds one connection for as long as Postgres scans. The counter is
 * in-process on purpose, because the pool it protects is too: each API process has its own
 * pool, so a per-process count bounds exactly what one team can hold of it, with no Redis
 * round trip on the request path. Across N processes one team can hold at most `max * N`
 * connections in total, each still bounded by the statement timeout.
 *
 * @param teamId - The team the search runs for.
 * @param max - Searches the team may have running at once; a positive integer.
 * @param fn - The search. Its slot is released when it settles, success or failure.
 * @returns Whatever `fn` returns.
 * @throws {RateLimitedError} 429, before `fn` runs, when the team already has `max`
 *   searches running. `retryAfter` is 1 second: a slot frees as soon as one finishes.
 */
export async function withTeamSearchSlot<T>(teamId: string, max: number, fn: () => Promise<T>): Promise<T> {
  const current = running.get(teamId) ?? 0;
  if (current >= max) {
    throw new RateLimitedError(
      `Too many trace searches are running for this team at once (limit ${max}). Wait for one to finish and try again.`,
      1,
    );
  }
  running.set(teamId, current + 1);
  try {
    return await fn();
  } finally {
    const left = (running.get(teamId) ?? 1) - 1;
    if (left > 0) running.set(teamId, left);
    else running.delete(teamId);
  }
}
