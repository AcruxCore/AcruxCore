process.env.GATEWAY_ENCRYPTION_KEY =
  process.env.GATEWAY_ENCRYPTION_KEY ?? Buffer.alloc(32, 9).toString('base64');

import prisma from '../../shared/db/client';
import { ConnectionsRepository } from './connections.repository';
import { resetAuthTables } from '../../test-utils';

const repo = new ConnectionsRepository();

async function truncate(): Promise<void> {
  // Delegates to the shared reset rather than keeping a local delete chain: every
  // such chain omitted a table that references `users` or `teams` (`audit_log`,
  // `tools`, ...), which passed alone and FK-violated in a full run the moment an
  // earlier suite left a row behind. `TRUNCATE ... CASCADE` reaches the
  // dependants automatically, so it needs no edit when a new domain lands.
  await resetAuthTables();
}

/** Creates a user + team directly so the repo has valid FKs to point at. */
async function seedUserAndTeam() {
  const user = await prisma.user.create({
    data: { email: `repo-${Date.now()}@test` },
  });
  const team = await prisma.team.create({ data: { name: 'Repo Team' } });
  return { userId: user.id, teamId: team.id };
}

beforeEach(truncate);
afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
});

describe('ConnectionsRepository', () => {
  it('create → findByIdForTeam round-trips the row within the team', async () => {
    const { userId, teamId } = await seedUserAndTeam();
    const row = await repo.create({
      teamId,
      provider: 'openai',
      label: 'Prod',
      secretCiphertext: Buffer.from('abc'),
      keyLastFour: 'AB12',
      config: {},
      createdBy: userId,
    });

    expect(row.id).toBeDefined();
    const found = await repo.findByIdForTeam(row.id, teamId);
    expect(found?.label).toBe('Prod');
  });

  it('findByIdForTeam returns undefined for another team', async () => {
    const a = await seedUserAndTeam();
    const b = await seedUserAndTeam();
    const row = await repo.create({
      teamId: a.teamId, provider: 'openai', label: 'A', secretCiphertext: Buffer.from('x'),
      keyLastFour: '0000', config: {}, createdBy: a.userId,
    });
    expect(await repo.findByIdForTeam(row.id, b.teamId)).toBeUndefined();
  });

  it('update patches label and delete removes the row', async () => {
    const { userId, teamId } = await seedUserAndTeam();
    const row = await repo.create({
      teamId, provider: 'anthropic', label: 'Old', secretCiphertext: Buffer.from('x'),
      keyLastFour: '0000', config: {}, createdBy: userId,
    });
    const updated = await repo.update(row.id, { label: 'New' });
    expect(updated.label).toBe('New');

    await repo.delete(row.id);
    expect(await repo.findByIdForTeam(row.id, teamId)).toBeUndefined();
  });
});
