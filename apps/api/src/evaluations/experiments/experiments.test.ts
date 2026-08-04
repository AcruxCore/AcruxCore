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

async function createPromptWithVersion(
  agent: ReturnType<typeof request.agent>,
  name: string,
  content: string,
): Promise<{ promptId: string; versionId: string }> {
  const prompt = (await agent.post('/api/v1/prompts').send({ name }).expect(201)).body;
  const version = (
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content }] })
      .expect(201)
  ).body;
  await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);
  return { promptId: prompt.id, versionId: version.id };
}

describe('POST /api/v1/experiments — alias baseline + prompt-mismatch warning', () => {
  it('resolves the auto-baseline via a named alias and labels the injected cell with it', async () => {
    const { agent } = await authedAgent(app);
    const { promptId } = await createPromptWithVersion(agent, 'exp-alias-a', 'Say hi to {{ name }}');
    await agent
      .post(`/api/v1/prompts/${promptId}/versions`)
      .send({ messages: [{ role: 'user', content: 'Say hi warmly to {{ name }}' }] })
      .expect(201);
    await agent.post(`/api/v1/prompts/${promptId}/aliases/staging/promote`).send({ version_number: 2 }).expect(200);
    const datasetId = await createDataset(agent, 1);

    const versions = (await agent.get(`/api/v1/prompts/${promptId}/versions`).expect(200)).body.data;
    const v1Id = versions.find((v: { versionNumber: number }) => v.versionNumber === 1).id;

    const experiment = (
      await agent
        .post('/api/v1/experiments')
        .send({ dataset_id: datasetId, prompt_id: promptId, version_ids: [v1Id], models: ['gpt-4o-mini'], alias: 'staging' })
        .expect(201)
    ).body;
    expect(experiment.config.alias).toBe('staging');

    const run = (await agent.post(`/api/v1/experiments/${experiment.id}/runs`).expect(202)).body;
    const runRow = await prisma.experimentRun.findUnique({ where: { id: run.run_id } });
    const grid = runRow!.grid as Array<{ variantLabel: string }>;
    expect(grid.some((c) => c.variantLabel === 'staging')).toBe(true);
    expect(grid.some((c) => c.variantLabel === 'production')).toBe(false);
  });

  it('includes a prompt-mismatch warning when the dataset was built from a different prompt, but still creates the experiment', async () => {
    const { agent, teamId } = await authedAgent(app);
    const credId = await agent
      .post('/api/v1/gateway/connections')
      .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
      .expect(201);
    await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: credId.body.id })
      .expect(201);

    const { promptId: promptAId } = await createPromptWithVersion(agent, 'exp-mismatch-a', 'Say hi to {{ name }}');

    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hi Al' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      text: async () => '',
    } as unknown as Response);
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'exp-mismatch-a', alias: 'production', variables: { name: 'Al' } } })
      .expect(200);

    const trace = await prisma.trace.findFirst({ where: { teamId } });
    const fb = (
      await agent.post(`/api/v1/traces/${trace!.id}/feedback`).send({ rating: -1, comment: 'meh' }).expect(201)
    ).body;
    const dataset = (
      await agent.post('/api/v1/datasets/from-feedback').send({ name: 'from-a', feedback_ids: [fb.id] }).expect(201)
    ).body;

    const { promptId: promptBId, versionId: v1BId } = await createPromptWithVersion(agent, 'exp-mismatch-b', 'Greet {{ name }}');

    const experiment = (
      await agent
        .post('/api/v1/experiments')
        .send({ dataset_id: dataset.id, prompt_id: promptBId, version_ids: [v1BId], models: ['gpt-4o-mini'] })
        .expect(201)
    ).body;

    expect(experiment.promptMismatchWarning.mismatchedPrompts).toEqual([
      { promptId: promptAId, name: 'exp-mismatch-a', exampleCount: 1 },
    ]);

    jest.restoreAllMocks();
  });

  it('rejects a nonexistent alias synchronously with a 404 when starting a run', async () => {
    const { agent } = await authedAgent(app);
    const { promptId, versionId } = await createPromptWithVersion(agent, 'exp-bad-alias', 'Say hi to {{ name }}');
    const datasetId = await createDataset(agent, 1);

    const experiment = (
      await agent
        .post('/api/v1/experiments')
        .send({
          dataset_id: datasetId,
          prompt_id: promptId,
          version_ids: [versionId],
          models: ['gpt-4o-mini'],
          alias: 'nonexistent-alias',
        })
        .expect(201)
    ).body;

    // Resolving the auto-baseline happens synchronously inside startRun
    // (before the run row is created), so the NotFoundError propagates
    // straight out as a 404 — no run is ever queued.
    const res = await agent.post(`/api/v1/experiments/${experiment.id}/runs`).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');

    const runCount = await prisma.experimentRun.count({ where: { experimentId: experiment.id } });
    expect(runCount).toBe(0);
  });
});
