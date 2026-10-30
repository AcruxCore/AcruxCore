import type { Prisma } from '@prisma/client';

/**
 * Every advisory-lock namespace that {@link lockTeamName} uses, in one table so two
 * resources can never share a number. Postgres locks on the pair
 * `(namespace, hashtext(key))`, so a reused number would make unrelated writers
 * block each other. Add a new entry here; never pick a number inline.
 */
export const LockNamespace = {
  ToolName: 4271,
  PromptName: 4272,
} as const;

/** One of the numbers in {@link LockNamespace}. */
export type LockNamespace = (typeof LockNamespace)[keyof typeof LockNamespace];

/**
 * Takes a transaction-scoped advisory lock on a name inside a team, so every
 * writer that claims the same `(teamId, name)` runs its check-then-insert one
 * at a time.
 *
 * A partial unique index would do this in the database, but Prisma's schema cannot
 * express `WHERE deleted_at IS NULL`, so a later `prisma migrate dev` would drop
 * it (phase-4 FAQ Q47). The lock is released when the transaction commits or rolls
 * back; there is no unlock call and nothing leaks if the caller throws.
 *
 * @param tx - The transaction to scope the lock to. Required: a lock taken outside
 *   a transaction would be released at once and protect nothing.
 * @param namespace - Which kind of name is being claimed.
 * @param teamId - Owning team; part of the key, so two teams never block each other.
 * @param name - The name being claimed, exactly as it will be stored.
 */
export async function lockTeamName(
  tx: Prisma.TransactionClient,
  namespace: LockNamespace,
  teamId: string,
  name: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${namespace}::int, hashtext(${`${teamId}:${name}`}))`;
}
