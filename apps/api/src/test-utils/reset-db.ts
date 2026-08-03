import prisma from '../shared/db/client';

/**
 * Empties the tenancy root — users, teams, and everything that hangs off them.
 *
 * The shared reset for **any** suite that needs a clean database, not just the
 * auth ones (the name predates that). Prefer it over a local delete chain.
 *
 * `TRUNCATE ... CASCADE` rather than a sequence of `deleteMany()` calls: each
 * suite runs in-band alongside ~100 others, so rows left behind by an earlier
 * file still reference `users` and `teams`. Deleting a parent row then fails on
 * a foreign key from a table this suite has never heard of — and adding those
 * tables to a delete list one FK violation at a time is a losing game, because
 * the list grows with every future domain. That is not hypothetical: eleven
 * suites each carried their own chain, every one of them missing a table, and
 * they failed in whichever combination the run happened to order them in.
 *
 * Only the roots are listed below. CASCADE reaches the dependants — `prompts`,
 * `tools`, `virtual_keys`, `gateway_requests`, `budgets`, and whatever the next
 * domain adds — so this list should not need to grow.
 *
 * @throws If the statement fails — a truncation that silently did nothing would
 *   leak state into the next test.
 */
export async function resetAuthTables(): Promise<void> {
  await prisma.$executeRaw`TRUNCATE TABLE
    email_log, notification_preferences, team_invites, audit_log,
    api_keys, team_members, teams,
    auth_sessions, auth_accounts, auth_verifications, known_devices, users
  RESTART IDENTITY CASCADE`;
}
