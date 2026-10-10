/**
 * Live integration test for the Evaluations SDK domain. Boots the real API
 * in-process on a free port, against the database in the repo's `.env`.
 *
 * Opt-in: npx jest test/integration/eval-live.test.ts --runInBand
 * Excluded from `npm test` and `npm run test:integration` (see package.json).
 */
import { acruxcore } from '../../src/client';
import http from 'http';
import prisma from '../../../../apps/api/src/shared/db/client';
import { signupTestUserWithApiKey } from '../../../../apps/api/src/test-utils/auth';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require('../../../../apps/api/app');

describe('Evaluations SDK — live', () => {
  let hub: acruxcore;
  const DATASET_NAME = 'SDK Eval Live Test Dataset';
  let datasetId = '';
  let exampleId = '';
  let server: http.Server;

  beforeAll(async () => {
    const app = createApp();
    const { apiKey } = await signupTestUserWithApiKey(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    hub = new acruxcore({ apiKey, baseUrl: `http://localhost:${port}/api/v1`, maxRetries: 0 });
  });

  afterAll(async () => {
    if (datasetId) {
      await hub.datasets.delete(datasetId);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  });

  test('create dataset', async () => {
    const ds = await hub.datasets.create({ name: DATASET_NAME, overallFeedback: 'Keep replies short' });
    expect(ds.id).toBeTruthy();
    expect(ds.name).toBe(DATASET_NAME);
    expect(ds.overallFeedback).toBe('Keep replies short');
    datasetId = ds.id;
  });

  test('add example', async () => {
    const ex = await hub.datasets.addExample(datasetId, {
      input: { question: 'What is 2+2?' },
      criteria: 'Must answer 4',
    });
    expect(ex.id).toBeTruthy();
    exampleId = ex.id;
  });

  test('add examples in bulk', async () => {
    const result = await hub.datasets.addExamples(datasetId, [
      { input: { question: 'What is 3+3?' }, criteria: 'Must answer 6' },
      { input: { question: 'What is 5+5?' } },
    ]);
    expect(result).toEqual({ added: 2, exampleCount: 3 });
  });

  test('get dataset with examples', async () => {
    const ds = await hub.datasets.get(datasetId);
    expect(ds.id).toBe(datasetId);
    expect(ds.examples.length).toBeGreaterThanOrEqual(1);
  });

  test('list datasets', async () => {
    const list = await hub.datasets.list();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  test('update dataset', async () => {
    const ds = await hub.datasets.update(datasetId, { name: `${DATASET_NAME} (updated)` });
    expect(ds.name).toBe(`${DATASET_NAME} (updated)`);
  });

  test('remove example', async () => {
    await hub.datasets.removeExample(datasetId, exampleId);
  });

  test('list experiments', async () => {
    const list = await hub.experiments.list();
    expect(Array.isArray(list)).toBe(true);
  });

  test('list runs', async () => {
    const res = await hub.runs.list({ limit: 5 });
    expect(res.data).toBeTruthy();
    expect(res.total).toBeGreaterThanOrEqual(0);
  });
});
