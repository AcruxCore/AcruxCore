import { Prisma } from '@prisma/client';
import prisma from './client';

/** Postgres SQLSTATE `query_canceled`, raised when `statement_timeout` stops a statement. */
const QUERY_CANCELED = '57014';

/**
 * Runs `fn` in one transaction whose statements Postgres stops after `timeoutMs` each.
 *
 * The timeout is set with `set_config(..., is_local => true)`, the parameterised form of
 * `SET LOCAL`, so it ends with the transaction and never leaks onto the pooled connection
 * (or a pgBouncer server connection) the next request gets. It is enforced by Postgres
 * itself, so a statement stops even after the HTTP client that asked for it has gone,
 * which an in-process timer could not do.
 *
 * The transaction's own budget is set above the statements' so the statement timeout,
 * which cancels the work in Postgres, always fires first.
 *
 * @param timeoutMs - Per-statement limit in milliseconds; a positive integer.
 * @param fn - The queries to run; must use the given transaction client for each.
 * @returns Whatever `fn` returns.
 * @throws The error of the first failing statement; test it with {@link isStatementTimeout}.
 */
export function runWithStatementTimeout<T>(
  timeoutMs: number,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`;
      return fn(tx);
    },
    // Two statements per search (page + count) plus slack; wait for a connection as long
    // as a plain query would (Prisma's default pool timeout is 10s).
    { timeout: timeoutMs * 2 + 2_000, maxWait: 10_000 },
  );
}

/**
 * Whether `err` is Postgres stopping a statement at its `statement_timeout`.
 *
 * @param err - Any thrown value.
 * @returns True for Prisma's raw-query failure (`P2010`) carrying SQLSTATE 57014.
 */
export function isStatementTimeout(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2010' &&
    (err.meta as { code?: unknown } | undefined)?.code === QUERY_CANCELED
  );
}
