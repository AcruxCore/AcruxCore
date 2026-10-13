import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';
import { drainEmailQueue, getEmailQueue } from '../../email/email.queue';
import { getMemoryTransport } from '../../email/memory.transport';
import { RunsRepository } from './runs.repository';
import { reapStaleRuns } from './stale-runs.processor';

const app = createApp();
const runsRepo = new RunsRepository();

const STALE_MINUTES = 120;
const HOUR_MS = 60 * 60 * 1000;

interface Arranged {
  experimentId: string;
  promptVersionId: string;
  exampleId: string;
}

/** A prompt, dataset, and experiment, so run rows satisfy their foreign keys. */
async function arrange(agent: ReturnType<typeof request.agent>): Promise<Arranged> {
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id })
    .expect(201);

  const prompt = (await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
  const version = (
    await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] })
      .expect(201)
  ).body;
  const dataset = (await agent.post('/api/v1/datasets').send({ name: 'greetings' }).expect(201)).body;
  const example = (
    await agent.post(`/api/v1/datasets/${dataset.id}/examples`).send({ input: { name: 'Al' } }).expect(201)
  ).body;
  const experiment = (
    await agent
      .post('/api/v1/experiments')
      .send({ dataset_id: dataset.id, prompt_id: prompt.id, version_ids: [version.id], models: ['gpt-4o-mini'] })
      .expect(201)
  ).body;

  return { experimentId: experiment.id, promptVersionId: version.id, exampleId: example.id };
}

/**
 * Creates a run and places it in a given state, as if it had been created
 * `ageHours` ago. No queue job is enqueued: that is the point — these are the
 * runs whose jobs are gone.
 */
async function createRunInState(
  teamId: string,
  userId: string,
  arranged: Arranged,
  state: { status: 'queued' | 'running' | 'succeeded'; ageHours: number },
): Promise<string> {
  const run = await runsRepo.createRun(teamId, arranged.experimentId, {
    exampleSnapshot: [{ exampleId: arranged.exampleId, input: { name: 'Al' }, criteria: null }],
    grid: [
      {
        cellKey: 'v1|gpt-4o-mini',
        variantKind: 'version',
        promptVersionId: arranged.promptVersionId,
        versionLabel: 'v1',
        model: 'gpt-4o-mini',
      },
    ],
    createdBy: userId,
  });
  const created = new Date(Date.now() - state.ageHours * HOUR_MS);
  await prisma.experimentRun.update({
    where: { id: run.id },
    data: {
      status: state.status,
      createdAt: created,
      startedAt: state.status === 'queued' ? null : created,
      endedAt: state.status === 'succeeded' ? created : null,
    },
  });
  return run.id;
}

/** Writes one cell result for a run, created `ageHours` ago. */
async function writeResultAged(teamId: string, runId: string, arranged: Arranged, ageHours: number): Promise<void> {
  const result = await runsRepo.writeResult({
    teamId,
    experimentRunId: runId,
    datasetExampleId: arranged.exampleId,
    variantKind: 'version',
    promptVersionId: arranged.promptVersionId,
    variantLabel: 'v1',
    model: 'gpt-4o-mini',
    output: 'Hi Al!',
  });
  await prisma.evalResult.update({
    where: { id: result.id },
    data: { createdAt: new Date(Date.now() - ageHours * HOUR_MS) },
  });
}

async function statusOf(runId: string): Promise<string> {
  return (await prisma.experimentRun.findUniqueOrThrow({ where: { id: runId } })).status;
}

beforeEach(async () => {
  await getEmailQueue().obliterate({ force: true });
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    eval_results, experiment_runs, experiments,
    dataset_examples, datasets,
    span_payloads, spans, trace_feedback, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys,
    gateway_model_fallbacks, gateway_models, provider_connections,
    prompt_aliases, prompt_versions, prompts,
    notification_preferences, email_log,
    audit_log, api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
  getMemoryTransport().reset();
});

describe('reapStaleRuns', () => {
  it('fails a running run whose jobs are gone, and tells the person who started it', async () => {
    const owner = await authedAgent(app);
    const arranged = await arrange(owner.agent);
    // Half-finished and then abandoned: one early result, nothing since.
    const runId = await createRunInState(owner.teamId, owner.userId, arranged, { status: 'running', ageHours: 5 });
    await writeResultAged(owner.teamId, runId, arranged, 5);

    const reaped = await reapStaleRuns({ staleMinutes: STALE_MINUTES });

    expect(reaped).toBe(1);
    const run = await prisma.experimentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('failed');
    expect(run.endedAt).not.toBeNull();
    expect(run.error).toContain('no progress');

    await drainEmailQueue();
    const sent = getMemoryTransport().sent();
    expect(sent.map((m) => m.to)).toEqual([owner.email]);
    expect(sent[0].subject).toContain('failed');
  });

  it('fails a run that never left queued, such as an optimize job lost before it started', async () => {
    const owner = await authedAgent(app);
    const arranged = await arrange(owner.agent);
    const runId = await createRunInState(owner.teamId, owner.userId, arranged, { status: 'queued', ageHours: 5 });

    expect(await reapStaleRuns({ staleMinutes: STALE_MINUTES })).toBe(1);

    expect(await statusOf(runId)).toBe('failed');
  });

  it('leaves alone a run that is still producing results, however old it is', async () => {
    const owner = await authedAgent(app);
    const arranged = await arrange(owner.agent);
    const runId = await createRunInState(owner.teamId, owner.userId, arranged, { status: 'running', ageHours: 5 });
    await writeResultAged(owner.teamId, runId, arranged, 0.1);

    expect(await reapStaleRuns({ staleMinutes: STALE_MINUTES })).toBe(0);

    expect(await statusOf(runId)).toBe('running');
  });

  it('leaves alone a run that started recently', async () => {
    const owner = await authedAgent(app);
    const arranged = await arrange(owner.agent);
    const runId = await createRunInState(owner.teamId, owner.userId, arranged, { status: 'running', ageHours: 0.2 });

    expect(await reapStaleRuns({ staleMinutes: STALE_MINUTES })).toBe(0);

    expect(await statusOf(runId)).toBe('running');
  });

  it('never touches a run that already reached a final status', async () => {
    const owner = await authedAgent(app);
    const arranged = await arrange(owner.agent);
    const runId = await createRunInState(owner.teamId, owner.userId, arranged, { status: 'succeeded', ageHours: 48 });

    expect(await reapStaleRuns({ staleMinutes: STALE_MINUTES })).toBe(0);

    expect(await statusOf(runId)).toBe('succeeded');
  });

  it('reaps runs across teams in one pass', async () => {
    const a = await authedAgent(app);
    const b = await authedAgent(app);
    const runA = await createRunInState(a.teamId, a.userId, await arrange(a.agent), { status: 'running', ageHours: 9 });
    const runB = await createRunInState(b.teamId, b.userId, await arrange(b.agent), { status: 'queued', ageHours: 9 });

    expect(await reapStaleRuns({ staleMinutes: STALE_MINUTES })).toBe(2);

    expect(await statusOf(runA)).toBe('failed');
    expect(await statusOf(runB)).toBe('failed');
  });
});
