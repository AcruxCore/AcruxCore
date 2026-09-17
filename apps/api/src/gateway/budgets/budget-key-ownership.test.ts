import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authHeaders, resetAuthTables, signupTestUser } from '../../test-utils';
import { BudgetsRepository } from './budgets.repository';

/**
 * The remediation half of the cross-tenant budget bug.
 *
 * `POST /api/v1/gateway/budgets` used to take `virtualKeyId` from the request
 * body without checking who owned it. That door is closed (a foreign key now
 * answers 404, covered in `cross-tenant.test.ts`), but the rows it could
 * already have written are still there, and they are worse than cosmetic: the
 * Budgets page lists such a row as an active spend cap while
 * `applicableBudgets` can never match it against any of the team's own calling
 * keys, so it caps nothing.
 *
 * This suite reconstructs that row, shows both halves of the problem, then runs
 * the shipped migration file — the real one, read off disk, so the test and the
 * SQL that runs in production cannot drift apart.
 */

const app = createApp();

const MIGRATION_SQL = path.join(
  __dirname,
  '../../../prisma/migrations/20260917000000_budget_virtual_key_must_be_own_team/migration.sql',
);

/**
 * Runs a Prisma migration file statement by statement.
 *
 * `$executeRawUnsafe` speaks the extended query protocol, which carries one
 * statement per message, so the file cannot be handed over whole.
 *
 * @param file - Absolute path to a `migration.sql`.
 */
async function applyMigration(file: string): Promise<void> {
  const sql = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  for (const statement of sql.split(';')) {
    if (statement.trim().length === 0) continue;
    await prisma.$executeRawUnsafe(statement);
  }
}

/**
 * Creates a virtual key row directly, for a team the caller is not signed in
 * as. Going through `POST /gateway/keys` would need a second session; the row
 * is all this suite needs.
 *
 * @param teamId - Owning team.
 * @param createdBy - Any existing user id (the column is a foreign key).
 * @param label - Distinguishes the two keys in a failure message.
 * @returns The new key's id.
 */
async function createKeyRow(teamId: string, createdBy: string, label: string): Promise<string> {
  const row = await prisma.virtualKey.create({
    data: {
      teamId,
      name: `budget-ownership-${label}`,
      keyHash: `hash-budget-ownership-${label}-${Date.now()}-${Math.random()}`,
      keyLastFour: '9999',
      createdBy,
    },
    select: { id: true },
  });
  return row.id;
}

beforeEach(async () => {
  await resetAuthTables();
});

afterAll(async () => {
  await resetAuthTables();
  await prisma.$disconnect();
});

describe('a budget may only point at a virtual key its own team owns', () => {
  it('removes the rows the old write path could have left, and refuses new ones', async () => {
    const ours = await signupTestUser(app);
    const theirs = await signupTestUser(app);

    // On a database where `prisma migrate deploy` has already run, the
    // constraint this migration adds is present and the row below cannot be
    // written at all — which is the point of the fix, but it means the test has
    // to put the schema back the way the bug left it before it can reproduce.
    await prisma.$executeRawUnsafe(
      'ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_virtual_key_team_fk',
    );

    const ourKey = await createKeyRow(ours.teamId, ours.userId, 'ours');
    const theirKey = await createKeyRow(theirs.teamId, theirs.userId, 'theirs');

    const orphan = await prisma.budget.create({
      data: {
        teamId: ours.teamId,
        virtualKeyId: theirKey,
        period: 'month',
        limitUsd: 50,
        createdBy: ours.userId,
      },
      select: { id: true },
    });

    // Half one: the dashboard lists it as a live spend cap.
    const listed = await request(app)
      .get('/api/v1/gateway/budgets')
      .set(authHeaders(ours))
      .expect(200);
    expect(listed.body.map((b: { id: string }) => b.id)).toContain(orphan.id);

    // Half two: it can never apply to anything. A call on our own key loads the
    // budgets that govern it, and this row is not among them — nor could it be,
    // since no key of ours carries that id.
    const repo = new BudgetsRepository();
    const applicable = await repo.applicableBudgets(ours.teamId, ourKey);
    expect(applicable.map((b) => b.id)).not.toContain(orphan.id);

    await applyMigration(MIGRATION_SQL);

    // The misleading row is gone. Nothing about enforcement changed: it capped
    // nothing before and caps nothing now.
    expect(await prisma.budget.findUnique({ where: { id: orphan.id } })).toBeNull();
    const afterList = await request(app)
      .get('/api/v1/gateway/budgets')
      .set(authHeaders(ours))
      .expect(200);
    expect(afterList.body).toHaveLength(0);

    // And the state is now unreachable, not merely cleaned up once.
    await expect(
      prisma.budget.create({
        data: {
          teamId: ours.teamId,
          virtualKeyId: theirKey,
          period: 'month',
          limitUsd: 50,
          createdBy: ours.userId,
        },
      }),
    ).rejects.toThrow();
  });

  it('leaves a team-wide budget and a correctly scoped one alone', async () => {
    const ours = await signupTestUser(app);
    const ourKey = await createKeyRow(ours.teamId, ours.userId, 'kept');

    const teamWide = await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ours))
      .send({ virtualKeyId: null, period: 'month', limitUsd: 10 })
      .expect(201);
    const keyScoped = await request(app)
      .post('/api/v1/gateway/budgets')
      .set(authHeaders(ours))
      .send({ virtualKeyId: ourKey, period: 'day', limitUsd: 5 })
      .expect(201);

    await applyMigration(MIGRATION_SQL);

    // A null `virtual_key_id` is not checked by the foreign key at all (MATCH
    // SIMPLE), and a key the team owns satisfies it. Both must survive, or the
    // migration is a data loss rather than a cleanup.
    const ids = (
      await prisma.budget.findMany({ where: { teamId: ours.teamId }, select: { id: true } })
    ).map((b) => b.id);
    expect(ids.sort()).toEqual([teamWide.body.id, keyScoped.body.id].sort());
  });
});
