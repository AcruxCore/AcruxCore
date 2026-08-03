import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

async function truncateTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    experiment_runs, experiments,
    dataset_examples, datasets,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
}

async function createDataset(agent: ReturnType<typeof request.agent>, exampleCount = 0): Promise<string> {
  const created = (await agent.post('/api/v1/datasets').send({ name: 'grid-set' }).expect(201)).body;
  for (let i = 0; i < exampleCount; i++) {
    await agent
      .post(`/api/v1/datasets/${created.id}/examples`)
      .send({ input: { i } })
      .expect(201);
  }
  return created.id;
}

function uuids(n: number): string[] {
  return Array.from({ length: n }, () => randomUUID());
}

beforeEach(async () => {
  await truncateTables();
});

afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
});

describe('POST /api/v1/experiments — fan-out caps', () => {
  it('accepts a normal-sized grid unchanged', async () => {
    const { agent } = await authedAgent(app);
    const datasetId = await createDataset(agent, 3);

    const res = await agent
      .post('/api/v1/experiments')
      .send({ dataset_id: datasetId, version_ids: uuids(2), models: ['gpt-4o-mini', 'gpt-4o'] })
      .expect(201);

    expect(res.body.config.versionIds).toHaveLength(2);
    expect(res.body.config.models).toHaveLength(2);
  });

  it('rejects a version_ids array beyond the per-dimension cap (schema-level, 400)', async () => {
    const { agent } = await authedAgent(app);
    const datasetId = await createDataset(agent, 1);

    await agent
      .post('/api/v1/experiments')
      .send({ dataset_id: datasetId, version_ids: uuids(51), models: ['gpt-4o-mini'] })
      .expect(400);
  });

  it('rejects a models array beyond the per-dimension cap (schema-level, 400)', async () => {
    const { agent } = await authedAgent(app);
    const datasetId = await createDataset(agent, 1);

    await agent
      .post('/api/v1/experiments')
      .send({ dataset_id: datasetId, version_ids: uuids(1), models: Array.from({ length: 51 }, (_, i) => `m${i}`) })
      .expect(400);
  });

  it('rejects a grid whose combined size (version_ids × models × dataset examples) exceeds the ceiling, before any runs are queued', async () => {
    const { agent } = await authedAgent(app);
    // 20 versions x 20 models x 10 examples = 4000 > 2000 ceiling, but each
    // dimension alone stays under its own per-dimension cap.
    const datasetId = await createDataset(agent, 10);

    const res = await agent
      .post('/api/v1/experiments')
      .send({ dataset_id: datasetId, version_ids: uuids(20), models: Array.from({ length: 20 }, (_, i) => `m${i}`) })
      .expect(400);

    expect(res.body.error.message).toMatch(/grid|too large|exceeds/i);

    const count = await prisma.experiment.count();
    expect(count).toBe(0);
  });
});
