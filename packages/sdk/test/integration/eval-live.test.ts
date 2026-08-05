/**
 * Live integration test for the Evaluations SDK domain.
 * Requires ACRUXCORE_API_KEY and a running API at localhost:3001.
 *
 * Opt-in: npx jest test/integration/eval-live.test.ts --runInBand
 * Excluded from `npm test` and `npm run test:integration` (see package.json).
 */
import { acruxcore } from '../../src/client';
import prisma from '../../../../apps/api/src/shared/db/client';
import { signupTestUserWithApiKey } from '../../../../apps/api/src/test-utils/auth';

describe('Evaluations SDK — live', () => {
  let hub: acruxcore;
  const DATASET_NAME = 'SDK Eval Live Test Dataset';
  let datasetId = '';
  let exampleId = '';

  beforeAll(async () => {
    const { apiKey } = await signupTestUserWithApiKey(prisma, 'eval-live@test.com');
    hub = new acruxcore({ apiKey });
  });

  afterAll(async () => {
    if (datasetId) {
      await hub.datasets.delete(datasetId);
    }
  });

  test('create dataset', async () => {
    const ds = await hub.datasets.create({ name: DATASET_NAME });
    expect(ds.id).toBeTruthy();
    expect(ds.name).toBe(DATASET_NAME);
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
