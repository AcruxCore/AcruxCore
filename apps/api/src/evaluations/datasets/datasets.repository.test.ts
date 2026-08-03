import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import { DatasetsRepository } from './datasets.repository';

const repo = new DatasetsRepository();

async function truncate(): Promise<void> {
  await prisma.$executeRaw`TRUNCATE TABLE dataset_examples, datasets, teams, users RESTART IDENTITY CASCADE`;
}

async function seedTeam(): Promise<{ teamId: string; userId: string }> {
  const team = await prisma.team.create({ data: { name: 'Datasets Team' } });
  const user = await prisma.user.create({
    data: { email: `u_${Math.floor(Math.random() * 1e9)}@example.com` },
  });
  return { teamId: team.id, userId: user.id };
}

beforeEach(truncate);
afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
});

describe('DatasetsRepository.createDatasetWithExamples (Finding #23: bulk insert)', () => {
  it('creates a large batch of examples in one bulk insert, not one round trip per example', async () => {
    const { teamId, userId } = await seedTeam();
    const EXAMPLE_COUNT = 500;
    const examples = Array.from({ length: EXAMPLE_COUNT }, (_, i) => ({
      input: { i } as Prisma.InputJsonValue,
    }));

    const start = Date.now();
    const { dataset, examplesCreated } = await repo.createDatasetWithExamples(
      teamId,
      userId,
      { name: 'bulk-dataset' },
      examples,
    );
    const elapsedMs = Date.now() - start;

    expect(examplesCreated).toBe(EXAMPLE_COUNT);
    expect(dataset._count.examples).toBe(EXAMPLE_COUNT);

    const rowCount = await prisma.datasetExample.count({ where: { datasetId: dataset.id } });
    expect(rowCount).toBe(EXAMPLE_COUNT);

    // Coarse insurance against a regression back to N sequential round trips:
    // a single bulk INSERT for 500 rows against a local test DB comfortably
    // finishes in well under a second; 500 individual awaited creates would not.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('still creates zero examples cleanly when the array is empty', async () => {
    const { teamId, userId } = await seedTeam();
    const { dataset, examplesCreated } = await repo.createDatasetWithExamples(
      teamId,
      userId,
      { name: 'empty-dataset' },
      [],
    );
    expect(examplesCreated).toBe(0);
    expect(dataset._count.examples).toBe(0);
  });
});
