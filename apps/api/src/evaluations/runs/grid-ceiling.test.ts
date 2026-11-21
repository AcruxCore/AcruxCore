import type request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { MAX_EXPERIMENT_DIMENSION, MAX_EXPERIMENT_GRID_SIZE } from '../experiments/experiments.types';
import { MAX_EXAMPLES_PER_BULK } from '../datasets/datasets.types';
import { getFlowProducer, getCellsQueue, getRunsQueue, getOptimizeQueue, getRedisConnection } from '../queue';
import { authedAgent } from '../../test-utils';

/**
 * Every cell job is one paid provider call, so a run may never enqueue more than
 * MAX_EXPERIMENT_GRID_SIZE of them. The ceiling holds where the jobs are created, not
 * only at experiment create: a dataset grows through bulk adds afterwards, and optimize
 * has no experiment-create step at all (issue #867, F02).
 */

const app = createApp();
type Agent = ReturnType<typeof request.agent>;

async function truncateTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    eval_results, prompt_candidates, experiment_runs, experiments, dataset_examples, datasets,
    gateway_models, provider_connections,
    prompt_aliases, prompt_versions, prompts, audit_log, api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
}
async function clearQueues(): Promise<void> {
  await getCellsQueue().obliterate({ force: true });
  await getRunsQueue().obliterate({ force: true });
  await getOptimizeQueue().obliterate({ force: true });
}

beforeEach(async () => {
  await truncateTables();
  await clearQueues();
});
afterEach(clearQueues);
afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
  // The queues share the one memoized connection, so closing it is enough.
  await getFlowProducer().close();
  await getRedisConnection().quit();
});

/** A registered model, a prompt with v1 on production, and a one-example dataset. */
async function arrange(agent: Agent): Promise<{ promptId: string; versionId: string; datasetId: string }> {
  const conn = (await agent.post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} }).expect(201)).body;
  await agent.post('/api/v1/gateway/models')
    .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.id }).expect(201);
  const prompt = (await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
  const v1 = (await agent.post(`/api/v1/prompts/${prompt.id}/versions`)
    .send({ messages: [{ role: 'system', content: 'Answer as {{ name }}' }] }).expect(201)).body;
  await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);
  const dataset = (await agent.post('/api/v1/datasets').send({ name: 'cases' }).expect(201)).body;
  await agent.post(`/api/v1/datasets/${dataset.id}/examples`)
    .send({ input: { name: 'seed' }, criteria: 'polite' }).expect(201);
  return { promptId: prompt.id, versionId: v1.id, datasetId: dataset.id };
}

/** Adds `count` examples through the bulk endpoint, MAX_EXAMPLES_PER_BULK at a time. */
async function grow(agent: Agent, datasetId: string, count: number): Promise<void> {
  for (let added = 0; added < count; added += MAX_EXAMPLES_PER_BULK) {
    const n = Math.min(MAX_EXAMPLES_PER_BULK, count - added);
    const rows = Array.from({ length: n }, (_, i) => ({ input: { name: `n${added + i}` } }));
    await agent.post(`/api/v1/datasets/${datasetId}/examples/bulk`).send({ examples: rows }).expect(201);
  }
}

describe('grid-size ceiling', () => {
  it('refuses to start a run once the dataset has grown past the ceiling, and queues nothing', async () => {
    const { agent } = await authedAgent(app);
    const { promptId, versionId, datasetId } = await arrange(agent);
    const experiment = (await agent.post('/api/v1/experiments').send({
      dataset_id: datasetId, prompt_id: promptId, version_ids: [versionId], models: ['gpt-4o-mini'], judge_model: 'gpt-4o-mini',
    }).expect(201)).body;

    await grow(agent, datasetId, MAX_EXPERIMENT_GRID_SIZE); // 1 seed + 2000 = 2001 examples

    const res = await agent.post(`/api/v1/experiments/${experiment.id}/runs`).expect(400);
    expect(res.body.error.message).toContain(`would enqueue ${MAX_EXPERIMENT_GRID_SIZE + 1} runs`);
    expect(await prisma.experimentRun.count({ where: { experimentId: experiment.id } })).toBe(0);
    expect(await getCellsQueue().getJobCounts()).toMatchObject({ waiting: 0, 'waiting-children': 0 });
  }, 120000);

  it('counts the baseline cell at experiment create, so a created experiment can start', async () => {
    const { agent } = await authedAgent(app);
    const { promptId, datasetId } = await arrange(agent); // v1 is on production
    const v2 = (await agent.post(`/api/v1/prompts/${promptId}/versions`)
      .send({ messages: [{ role: 'system', content: 'Reply as {{ name }}' }] }).expect(201)).body;
    // 1 seed + 1000 = 1001 examples. v2 alone is 1001 cells; with the production
    // baseline a run would build 2 x 1001 = 2002, so create must refuse it.
    await grow(agent, datasetId, 1000);

    const res = await agent.post('/api/v1/experiments').send({
      dataset_id: datasetId, prompt_id: promptId, version_ids: [v2.id], models: ['gpt-4o-mini'], judge_model: 'gpt-4o-mini',
    }).expect(400);
    expect(res.body.error.message).toContain('would enqueue 2002 runs');
    expect(await prisma.experiment.count()).toBe(0);
  }, 120000);

  it('refuses an optimize run whose drafts x models x examples would pass the ceiling', async () => {
    const { agent } = await authedAgent(app);
    const { promptId, datasetId } = await arrange(agent);
    // 1 seed + 500 = 501 examples; 3 drafts + the baseline on one model = 4 x 501 = 2004.
    await grow(agent, datasetId, MAX_EXAMPLES_PER_BULK);

    const res = await agent.post(`/api/v1/prompts/${promptId}/optimize`)
      .send({ dataset_id: datasetId, models: ['gpt-4o-mini'], judge_model: 'gpt-4o-mini', draft_count: 3 })
      .expect(400);
    expect(res.body.error.message).toContain('would enqueue 2004 runs');
    expect(await prisma.experimentRun.count()).toBe(0);
    expect(await getOptimizeQueue().getJobCounts()).toMatchObject({ waiting: 0 });

    // Two drafts instead: 3 x 501 = 1503 fits.
    await agent.post(`/api/v1/prompts/${promptId}/optimize`)
      .send({ dataset_id: datasetId, models: ['gpt-4o-mini'], judge_model: 'gpt-4o-mini', draft_count: 2 })
      .expect(202);
  }, 120000);

  it('caps the optimize models list like an experiment\'s', async () => {
    const { agent } = await authedAgent(app);
    const { promptId, datasetId } = await arrange(agent);
    const models = Array.from({ length: MAX_EXPERIMENT_DIMENSION + 1 }, () => 'gpt-4o-mini');
    await agent.post(`/api/v1/prompts/${promptId}/optimize`)
      .send({ dataset_id: datasetId, models, judge_model: 'gpt-4o-mini', draft_count: 1 })
      .expect(400);
    expect(await prisma.experimentRun.count()).toBe(0);
  });
});
