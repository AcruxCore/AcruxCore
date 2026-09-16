import { createApp } from '../../app';
import prisma from '../shared/db/client';
import { authedAgent, registerTestModel } from '../test-utils';

/**
 * What the evaluations domain leaves behind in the audit trail.
 *
 * The trail page promises "every recorded action in this team", and two of the
 * actions here are the kind a team most needs a record of: deleting a dataset
 * destroys the material every past run was measured against, and creating or
 * enabling an evaluation rule commits the team to a judge call per sampled
 * span from then on. Neither wrote a row (issue #508) — not because a call
 * broke, but because the calls were never written, and `audit()` is
 * fire-and-forget, so nothing failed to say so.
 *
 * The two gateway writes in `arrange` are the control: they prove the trail is
 * recording at all, so an empty result here means these events are missing
 * rather than the whole mechanism being down.
 */
const app = createApp();

async function truncateTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    eval_rule_scores, eval_rules,
    eval_results, experiment_runs, experiments,
    dataset_examples, datasets,
    span_payloads, spans, traces, team_trace_settings,
    gateway_model_fallbacks, gateway_models, provider_connections,
    prompt_aliases, prompt_versions, prompts,
    audit_log, api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
}

beforeEach(truncateTables);
afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
});

/** Every audit event recorded for a team, oldest first. */
async function eventsFor(teamId: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    where: { teamId },
    orderBy: { createdAt: 'asc' },
    select: { event: true },
  });
  return rows.map((r) => r.event);
}

describe('the evaluations domain writes to the audit trail (issue #508)', () => {
  it('records a dataset being created and deleted, with who did it', async () => {
    const { agent, teamId, userId } = await authedAgent(app);

    const created = await agent
      .post('/api/v1/datasets')
      .send({ name: 'regression set', description: 'the set every run is measured against' })
      .expect(201);

    await agent.delete(`/api/v1/datasets/${created.body.id}`).expect(200);

    expect(await eventsFor(teamId)).toEqual(['dataset_created', 'dataset_deleted']);

    const rows = await prisma.auditLog.findMany({ where: { teamId }, orderBy: { createdAt: 'asc' } });
    for (const row of rows) {
      expect(row.actorId).toBe(userId);
      expect((row.metadata as Record<string, unknown>)['datasetId']).toBe(created.body.id);
      expect((row.metadata as Record<string, unknown>)['name']).toBe('regression set');
    }
  });

  it('records an evaluation rule being created, changed and deleted', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    // The control: a registered model is two audit writes from a different domain.
    const judgeModel = await registerTestModel(agent);
    expect(await eventsFor(teamId)).toEqual(['provider_connection_created', 'gateway_model_created']);

    const created = await agent
      .post('/api/v1/eval-rules')
      .send({ name: 'quality gate', criteria: 'answers the question asked', sampleRate: 1, judgeModel })
      .expect(201);
    await agent.patch(`/api/v1/eval-rules/${created.body.id}`).send({ enabled: false }).expect(200);
    await agent.delete(`/api/v1/eval-rules/${created.body.id}`).expect(200);

    expect(await eventsFor(teamId)).toEqual([
      'provider_connection_created',
      'gateway_model_created',
      'eval_rule_created',
      'eval_rule_updated',
      'eval_rule_deleted',
    ]);

    const ruleRows = await prisma.auditLog.findMany({
      where: { teamId, event: { in: ['eval_rule_created', 'eval_rule_updated', 'eval_rule_deleted'] } },
    });
    for (const row of ruleRows) {
      expect(row.actorId).toBe(userId);
      expect((row.metadata as Record<string, unknown>)['ruleId']).toBe(created.body.id);
    }
  });

  it('records the dataset a rule builds from its low scores, with the person who built it', async () => {
    // `to-dataset` creates a dataset through the repository rather than through
    // `DatasetsService`, so it skipped both the audit row and `createdBy` — the
    // one dataset in the product that appeared from nowhere and belonged to no one.
    const { agent, teamId, userId } = await authedAgent(app);
    const judgeModel = await registerTestModel(agent);
    const created = await agent
      .post('/api/v1/eval-rules')
      .send({ name: 'quality gate', criteria: 'answers the question', sampleRate: 1, judgeModel })
      .expect(201);

    const built = await agent
      .post(`/api/v1/eval-rules/${created.body.id}/to-dataset`)
      .send({ datasetName: 'rule failures', threshold: 50 })
      .expect(201);

    const row = await prisma.auditLog.findFirst({ where: { teamId, event: 'dataset_created' } });
    expect(row?.actorId).toBe(userId);
    expect((row?.metadata as Record<string, unknown>)['datasetId']).toBe(built.body.id);

    const dataset = await prisma.dataset.findUnique({ where: { id: built.body.id } });
    expect(dataset?.createdBy).toBe(userId);
  });

  it('says what changed when a rule is switched off, so the trail explains the spend stopping', async () => {
    const { agent, teamId } = await authedAgent(app);
    const judgeModel = await registerTestModel(agent);
    const created = await agent
      .post('/api/v1/eval-rules')
      .send({ name: 'quality gate', criteria: 'answers the question', sampleRate: 1, judgeModel })
      .expect(201);

    await agent.patch(`/api/v1/eval-rules/${created.body.id}`).send({ enabled: false }).expect(200);

    const row = await prisma.auditLog.findFirst({ where: { teamId, event: 'eval_rule_updated' } });
    expect((row?.metadata as Record<string, unknown>)['enabled']).toBe(false);
  });
});
