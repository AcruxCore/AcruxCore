import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { processCell, processFinalize } from '.';
import { RunsRepository } from './runs.repository';
import { getFlowProducer, getJudgeQueue, getRunsQueue, getCellsQueue, getRedisConnection } from '../queue';
import { authedAgent } from '../../test-utils';

/**
 * A run freezes its examples into `exampleSnapshot` so its numbers never change after
 * the fact (phase-5 FAQ Q5). Deleting an example from the live dataset must therefore
 * leave every run that graded it whole: its results, report, drill-down and re-judge
 * (issue #867, F01).
 */
const app = createApp();
const runsRepo = new RunsRepository();

const CANNED_OPENAI = {
  id: 'chatcmpl-int', object: 'chat.completion', created: 1751536800, model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi Al!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
};

async function truncateTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    eval_results, prompt_candidates, experiment_runs, experiments, dataset_examples, datasets,
    span_payloads, spans, trace_feedback, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys,
    gateway_model_fallbacks, gateway_models, provider_connections,
    prompt_aliases, prompt_versions, prompts, audit_log, api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
}
beforeEach(truncateTables);
afterEach(async () => {
  jest.restoreAllMocks();
  // Here, not inline, so a failed assertion cannot leave jobs for the next suite.
  await getJudgeQueue().obliterate({ force: true });
  await getRunsQueue().obliterate({ force: true });
  await getCellsQueue().obliterate({ force: true });
});
afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
  await getFlowProducer().close();
  await getJudgeQueue().close(); await getRunsQueue().close(); await getCellsQueue().close();
  await getRedisConnection().quit();
});

it('deleting a dataset example leaves a finished run\'s results, report and re-judge intact', async () => {
  const { agent, teamId } = await authedAgent(app);
  const conn = (await agent.post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} }).expect(201)).body;
  await agent.post('/api/v1/gateway/models').send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.id }).expect(201);
  const prompt = (await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
  const v1 = (await agent.post(`/api/v1/prompts/${prompt.id}/versions`)
    .send({ messages: [{ role: 'user', content: 'Say hi to {{ name }}' }] }).expect(201)).body;
  const dataset = (await agent.post('/api/v1/datasets').send({ name: 'greetings' }).expect(201)).body;
  const exIds: string[] = [];
  // Bo has no criteria of its own, so the run grades it with none.
  for (const [name, criteria] of [['Al', 'be polite'], ['Bo', undefined]] as const) {
    exIds.push((await agent.post(`/api/v1/datasets/${dataset.id}/examples`).send({ input: { name }, criteria }).expect(201)).body.id);
  }
  const experiment = (await agent.post('/api/v1/experiments').send({
    dataset_id: dataset.id, prompt_id: prompt.id, version_ids: [v1.id], models: ['gpt-4o-mini'], judge_model: 'gpt-4o-mini',
  }).expect(201)).body;
  const runId = (await agent.post(`/api/v1/experiments/${experiment.id}/runs`).expect(202)).body.run_id;
  const run = await prisma.experimentRun.findUniqueOrThrow({ where: { id: runId } });

  // Drive every cell + judge verdict the way the worker would, then finalize.
  jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => CANNED_OPENAI, text: async () => JSON.stringify(CANNED_OPENAI) } as unknown as Response);
  for (const cell of run.grid as unknown as Array<Record<string, string>>) {
    for (const { exampleId } of run.exampleSnapshot as unknown as Array<{ exampleId: string }>) {
      await processCell({ teamId, runId, cellKey: cell.cellKey, variantKind: cell.variantKind as 'version', promptVersionId: cell.promptVersionId, variantLabel: cell.variantLabel, model: cell.model, exampleId });
    }
  }
  jest.restoreAllMocks();
  await getJudgeQueue().obliterate({ force: true });
  for (const r of await prisma.evalResult.findMany({ where: { experimentRunId: runId } })) {
    await runsRepo.writeVerdict(r.id, { score: 80, passed: true, reason: 'ok', judgeTraceId: null });
  }
  await processFinalize({ teamId, runId });
  const finished = await prisma.experimentRun.findUniqueOrThrow({ where: { id: runId } });
  expect(finished.status).toBe('succeeded');

  const rowsBefore = await prisma.evalResult.count({ where: { experimentRunId: runId } });
  const reportBefore = (await agent.get(`/api/v1/runs/${runId}/report`).expect(200)).body;

  await agent.delete(`/api/v1/datasets/${dataset.id}/examples/${exIds[0]}`).expect((r) => { if (r.status >= 300) throw new Error(`delete ${r.status}`); });

  const rowsAfter = await prisma.evalResult.count({ where: { experimentRunId: runId } });
  const reportAfter = (await agent.get(`/api/v1/runs/${runId}/report`).expect(200)).body;
  const rejudge = await agent.post(`/api/v1/runs/${runId}/rejudge`).send({ only_unscored: false });

  expect(rowsAfter).toBe(rowsBefore);
  expect(reportAfter.cells).toEqual(reportBefore.cells);
  expect(rejudge.status).toBe(202);

  // The drill-down still shows the deleted example, from the snapshot. (Its score is
  // null here only because the re-judge above clears scores before grading again.)
  const cellKey = encodeURIComponent(reportAfter.cells[0].cellKey);
  const cell = (await agent.get(`/api/v1/runs/${runId}/cells/${cellKey}`).expect(200)).body;
  const gone = cell.examples.find((e: { exampleId: string }) => e.exampleId === exIds[0]);
  expect(gone).toMatchObject({ input: { name: 'Al' }, criteria: 'be polite', output: expect.anything() });

  // Criteria added to Bo after the run must not appear beside a verdict graded without
  // any: the snapshot's explicit null is what the run saw.
  await agent.patch(`/api/v1/datasets/${dataset.id}/examples/${exIds[1]}`).send({ criteria: 'be concise' }).expect(200);
  const bo = (await agent.get(`/api/v1/runs/${runId}/cells/${cellKey}`).expect(200)).body
    .examples.find((e: { exampleId: string }) => e.exampleId === exIds[1]);
  expect(bo.criteria).toBeNull();
  const key = reportAfter.cells[0].cellKey;
  const compare = (await agent.get(`/api/v1/runs/${runId}/compare`).query({ base_cell: key, target_cell: key }).expect(200)).body;
  expect(compare.examples.find((e: { exampleId: string }) => e.exampleId === exIds[1]).criteria).toBeNull();
});
