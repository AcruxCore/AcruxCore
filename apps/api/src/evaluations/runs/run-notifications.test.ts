import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { addUserToTeam, authedAgent, type AuthedAgent } from '../../test-utils';
import { drainEmailQueue, getEmailQueue } from '../../email/email.queue';
import { getMemoryTransport } from '../../email/memory.transport';
import type { EmailMessage } from '../../email/email.types';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationsRepository } from '../../notifications/notifications.repository';
import { RunsRepository } from './runs.repository';
import { markFinalizeExhausted, processFinalize } from './finalize.processor';

const app = createApp();
const runsRepo = new RunsRepository();
const prefs = new NotificationsService(new NotificationsRepository());

/** A prompt, dataset, and experiment, so a run row satisfies its FKs. */
async function arrange(
  agent: ReturnType<typeof request.agent>,
): Promise<{ experimentId: string; promptVersionId: string; exampleId: string }> {
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
    await agent
      .post(`/api/v1/datasets/${dataset.id}/examples`)
      .send({ input: { name: 'Al' } })
      .expect(201)
  ).body;

  const experiment = (
    await agent
      .post('/api/v1/experiments')
      .send({
        dataset_id: dataset.id,
        prompt_id: prompt.id,
        version_ids: [version.id],
        models: ['gpt-4o-mini'],
      })
      .expect(201)
  ).body;

  return { experimentId: experiment.id, promptVersionId: version.id, exampleId: example.id };
}

/** A one-cell run, optionally attributed to a user. */
async function createRun(
  teamId: string,
  arranged: { experimentId: string; promptVersionId: string; exampleId: string },
  createdBy: string | null,
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
    createdBy,
  });
  await prisma.experimentRun.update({
    where: { id: run.id },
    data: { status: 'running', startedAt: new Date(Date.now() - 90_000) },
  });
  return run.id;
}

/** Writes the single judged result the finalize processor waits for. */
async function writeResult(
  teamId: string,
  runId: string,
  arranged: { promptVersionId: string; exampleId: string },
  errored: boolean,
): Promise<void> {
  if (errored) {
    await runsRepo.writeResultError({
      teamId,
      experimentRunId: runId,
      datasetExampleId: arranged.exampleId,
      variantKind: 'version',
      promptVersionId: arranged.promptVersionId,
      variantLabel: 'v1',
      model: 'gpt-4o-mini',
      errorMessage: 'provider exploded',
    });
    return;
  }

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
  await runsRepo.writeVerdict(result.id, {
    score: 1,
    passed: true,
    reason: 'good',
    judgeTraceId: null,
  });
}

/** Delivers everything queued and returns the accepted messages. */
async function flush(): Promise<EmailMessage[]> {
  await drainEmailQueue();
  return getMemoryTransport().sent();
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

describe('eval run finished notifications', () => {
  it('emails the person who started the run when it succeeds', async () => {
    const owner: AuthedAgent = await authedAgent(app);
    const starter = await addUserToTeam(app, owner.teamId, 'editor');
    const arranged = await arrange(owner.agent);
    const runId = await createRun(owner.teamId, arranged, starter.userId);
    await writeResult(owner.teamId, runId, arranged, false);

    await processFinalize({ teamId: owner.teamId, runId });

    const messages = await flush();
    // The starter, not the whole team — whoever kicked it off is who is waiting.
    expect(messages.map((m) => m.to)).toEqual([starter.email]);
    expect(messages[0].subject).toContain('finished');
    expect(messages[0].text).toContain('Cells succeeded: 1');
    expect(messages[0].text).toContain('Cells errored: 0');
    // Duration is reported from startedAt/endedAt, in m/s past a minute.
    expect(messages[0].text).toMatch(/Duration: 1m \d+s/);
  });

  it('also emails when the run fails — a failed run is more interesting, not less', async () => {
    const owner = await authedAgent(app);
    const arranged = await arrange(owner.agent);
    const runId = await createRun(owner.teamId, arranged, owner.userId);
    await writeResult(owner.teamId, runId, arranged, true);

    await processFinalize({ teamId: owner.teamId, runId });

    expect(await prisma.experimentRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: 'failed',
    });
    const messages = await flush();
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toContain('failed');
    expect(messages[0].text).toContain('Cells errored: 1');
  });

  it('never notifies nobody: a null createdBy falls back to the experiment creator', async () => {
    const owner = await authedAgent(app);
    const arranged = await arrange(owner.agent); // experiment.createdBy = owner
    const runId = await createRun(owner.teamId, arranged, null);
    await writeResult(owner.teamId, runId, arranged, false);

    await processFinalize({ teamId: owner.teamId, runId });

    expect((await flush()).map((m) => m.to)).toEqual([owner.email]);
  });

  it('falls back to the team owners when neither the run nor the experiment has a creator', async () => {
    const owner = await authedAgent(app);
    const arranged = await arrange(owner.agent);
    const runId = await createRun(owner.teamId, arranged, null);
    // Simulate a team-key caller all the way down: no acting user anywhere.
    await prisma.experiment.update({
      where: { id: arranged.experimentId },
      data: { createdBy: null },
    });
    await writeResult(owner.teamId, runId, arranged, false);

    await processFinalize({ teamId: owner.teamId, runId });

    expect((await flush()).map((m) => m.to)).toEqual([owner.email]);
  });

  it('sends one email however many times finalize retries', async () => {
    const owner = await authedAgent(app);
    const arranged = await arrange(owner.agent);
    const runId = await createRun(owner.teamId, arranged, owner.userId);
    await writeResult(owner.teamId, runId, arranged, false);

    // The finalize job legitimately retries many times while it waits on judge
    // jobs; each successful pass must not re-mail the same result.
    await processFinalize({ teamId: owner.teamId, runId });
    await processFinalize({ teamId: owner.teamId, runId });
    await processFinalize({ teamId: owner.teamId, runId });

    expect(await flush()).toHaveLength(1);
    expect(await prisma.emailLog.count({ where: { type: 'eval_run_finished' } })).toBe(1);
  });

  it('notifies when finalize gives up after exhausting its retries', async () => {
    const owner = await authedAgent(app);
    const arranged = await arrange(owner.agent);
    const runId = await createRun(owner.teamId, arranged, owner.userId);
    // No results written: this is the "judge jobs never settled" case.

    await markFinalizeExhausted({ teamId: owner.teamId, runId }, 'still in flight');

    const messages = await flush();
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toContain('failed');
  });

  it('respects an eval_runs opt-out', async () => {
    const owner = await authedAgent(app);
    const arranged = await arrange(owner.agent);
    const runId = await createRun(owner.teamId, arranged, owner.userId);
    await writeResult(owner.teamId, runId, arranged, false);
    await prefs.update(owner.teamId, owner.userId, { category: 'eval_runs', enabled: false });

    await processFinalize({ teamId: owner.teamId, runId });

    expect(await flush()).toHaveLength(0);
  });

  it('records who started a run via the API', async () => {
    const owner = await authedAgent(app);
    const arranged = await arrange(owner.agent);

    const res = await owner.agent
      .post(`/api/v1/experiments/${arranged.experimentId}/runs`)
      .send({})
      .expect(202);

    const run = await prisma.experimentRun.findUniqueOrThrow({ where: { id: res.body.run_id } });
    expect(run.createdBy).toBe(owner.userId);
  });
});
