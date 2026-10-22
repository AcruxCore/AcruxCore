import prisma from '../../../../apps/api/src/shared/db/client';
import { resetAuthTables } from '../../../../apps/api/src/test-utils/reset-db';
import {
  callTool,
  callToolExpectingError,
  payloadOf,
  rest,
  startHarness,
  type Harness,
} from './harness';

let harness: Harness;

beforeEach(async () => {
  await resetAuthTables();
  harness = await startHarness();
});

afterEach(async () => {
  await harness?.close();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Arranges a registered model, a prompt with v1, a dataset with one example, and a
 * judge prompt named "triage judge" with a committed v1. No model is called: these
 * tests stop once the run is queued.
 */
async function arrange(): Promise<{ promptId: string; versionId: string; datasetId: string; judgeV1: string }> {
  const connection = await rest<{ id: string }>(harness, 'POST', '/gateway/connections', {
    provider: 'openai',
    label: 'openai test',
    apiKey: 'sk-test-abcdAB12',
    config: {},
  });
  await rest(harness, 'POST', '/gateway/models', {
    publicName: 'gpt-4o-mini',
    upstreamModel: 'gpt-4o-mini',
    credentialId: connection.id,
  });

  const prompt = await rest<{ id: string }>(harness, 'POST', '/prompts', { name: 'triage' });
  const version = await rest<{ id: string }>(harness, 'POST', `/prompts/${prompt.id}/versions`, {
    messages: [{ role: 'user', content: 'Classify: {{ message }}' }],
  });
  const dataset = await rest<{ id: string }>(harness, 'POST', '/datasets', { name: 'triage cases' });
  await rest(harness, 'POST', `/datasets/${dataset.id}/examples`, {
    input: { message: 'I was charged twice.' },
    criteria: 'category billing',
  });

  const judge = await rest<{ id: string }>(harness, 'POST', '/prompts', { name: 'triage judge' });
  const judgeV1 = await rest<{ id: string }>(harness, 'POST', `/prompts/${judge.id}/versions`, {
    messages: [{ role: 'user', content: 'Score 0 unless the reply is JSON. {{ criteria }} {{ output }}' }],
  });

  return { promptId: prompt.id, versionId: version.id, datasetId: dataset.id, judgeV1: judgeV1.id };
}

describe('run_experiment', () => {
  it('sends the judge model, so the experiment is created and its run queued', async () => {
    const { versionId, datasetId } = await arrange();

    const text = await callTool(harness.client, 'run_experiment', {
      dataset_id: datasetId,
      version_ids: [versionId],
      models: ['gpt-4o-mini'],
      judge_model: 'gpt-4o-mini',
    });

    const { run } = payloadOf<{ run: { run_id: string } }>(text);
    const row = await prisma.experimentRun.findUniqueOrThrow({ where: { id: run.run_id } });
    expect(row.judgeModel).toBe('gpt-4o-mini');
    expect(row.judgePromptVersionId).toBeNull();
  });

  it('grades with a judge prompt named by name, frozen to its version on the run', async () => {
    const { versionId, datasetId, judgeV1 } = await arrange();

    const text = await callTool(harness.client, 'run_experiment', {
      dataset_id: datasetId,
      version_ids: [versionId],
      models: ['gpt-4o-mini'],
      judge_model: 'gpt-4o-mini',
      judge_prompt: 'triage judge',
    });

    const { experiment, run } = payloadOf<{ experiment: { config: { judgePromptId?: string } }; run: { run_id: string } }>(text);
    expect(experiment.config.judgePromptId).toBeDefined();
    const row = await prisma.experimentRun.findUniqueOrThrow({ where: { id: run.run_id } });
    expect(row.judgePromptVersionId).toBe(judgeV1);
  });

  it('refuses a judge prompt name that does not exist, before any experiment is created', async () => {
    const { versionId, datasetId } = await arrange();

    const error = await callToolExpectingError(harness.client, 'run_experiment', {
      dataset_id: datasetId,
      version_ids: [versionId],
      models: ['gpt-4o-mini'],
      judge_model: 'gpt-4o-mini',
      judge_prompt: 'no such judge',
    });

    expect(error).toContain('no such judge');
    expect(await prisma.experiment.count({ where: { teamId: harness.teamId } })).toBe(0);
  });
});

describe('optimize_prompt', () => {
  it('grades with a judge prompt named by name, frozen to its version on the run', async () => {
    const { promptId, datasetId, judgeV1 } = await arrange();
    await rest(harness, 'POST', `/prompts/${promptId}/aliases/production/promote`, { version_number: 1 });

    const text = await callTool(harness.client, 'optimize_prompt', {
      prompt: 'triage',
      dataset_id: datasetId,
      models: ['gpt-4o-mini'],
      judge_model: 'gpt-4o-mini',
      judge_prompt: 'triage judge',
    });

    const { run_id: runId } = payloadOf<{ run_id: string }>(text);
    const row = await prisma.experimentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.judgeModel).toBe('gpt-4o-mini');
    expect(row.judgePromptVersionId).toBe(judgeV1);
  });
});

describe('get_optimize_report', () => {
  it('names the judge prompt version that graded the run, so the caller can tell which rubric scored it', async () => {
    const { promptId, datasetId, judgeV1 } = await arrange();
    await rest(harness, 'POST', `/prompts/${promptId}/aliases/production/promote`, { version_number: 1 });
    const started = payloadOf<{ run_id: string }>(
      await callTool(harness.client, 'optimize_prompt', {
        prompt: 'triage',
        dataset_id: datasetId,
        models: ['gpt-4o-mini'],
        judge_model: 'gpt-4o-mini',
        judge_prompt: 'triage judge',
      }),
    );
    // The report body is only built for a finished run; no model is called here.
    await prisma.experimentRun.update({ where: { id: started.run_id }, data: { status: 'succeeded' } });

    const report = payloadOf<{ judgeModel: string; judgePromptVersionId: string | null }>(
      await callTool(harness.client, 'get_optimize_report', { run_id: started.run_id }),
    );

    expect(report.judgeModel).toBe('gpt-4o-mini');
    expect(report.judgePromptVersionId).toBe(judgeV1);
  });

  it('reads a queued optimize run as one, from the kind stored when it was created (issue #684)', async () => {
    const { promptId, datasetId } = await arrange();
    await rest(harness, 'POST', `/prompts/${promptId}/aliases/production/promote`, { version_number: 1 });
    const started = payloadOf<{ run_id: string }>(
      await callTool(harness.client, 'optimize_prompt', {
        prompt: 'triage',
        dataset_id: datasetId,
        models: ['gpt-4o-mini'],
        judge_model: 'gpt-4o-mini',
      }),
    );

    const text = await callTool(harness.client, 'get_optimize_report', { run_id: started.run_id });
    expect(text).toContain(`Optimize run ${started.run_id} is queued`);
  });

  it('says how many rewrites were dropped before scoring, and why (issue #686)', async () => {
    const { promptId, datasetId } = await arrange();
    await rest(harness, 'POST', `/prompts/${promptId}/aliases/production/promote`, { version_number: 1 });
    const started = payloadOf<{ run_id: string }>(
      await callTool(harness.client, 'optimize_prompt', {
        prompt: 'triage',
        dataset_id: datasetId,
        models: ['gpt-4o-mini'],
        judge_model: 'gpt-4o-mini',
      }),
    );
    const reason = 'candidate 2: template variables {} do not match the original {message}';
    await prisma.experimentRun.update({
      where: { id: started.run_id },
      data: { status: 'succeeded', optimizerRejections: [reason] },
    });

    const text = await callTool(harness.client, 'get_optimize_report', { run_id: started.run_id });
    expect(text).toContain(`1 more rewrite(s) were dropped before scoring: ${reason}`);
    expect(payloadOf<{ rejectedRewrites: string[] }>(text).rejectedRewrites).toEqual([reason]);
  });
});
