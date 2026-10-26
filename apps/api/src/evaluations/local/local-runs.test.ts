import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();
type Agent = ReturnType<typeof request.agent>;

/** A team with a three-example dataset whose rows carry structured `expected` values. */
async function arrange(): Promise<{ agent: Agent; teamId: string; datasetId: string }> {
  const { agent, teamId } = await authedAgent(app);
  const dataset = (await agent.post('/api/v1/datasets').send({ name: 'orders' }).expect(201)).body;
  await agent
    .post(`/api/v1/datasets/${dataset.id}/examples/bulk`)
    .send({
      examples: [
        { input: { message: 'two coffees' }, expected: { total: 8 } },
        { input: { message: 'one tea' }, expected: { total: 3 }, criteria: 'Be polite.' },
        { input: { message: 'nothing' } },
      ],
    })
    .expect(201);
  return { agent, teamId, datasetId: dataset.id };
}

/** Starts a local run and returns the create response body. */
async function startLocal(agent: Agent, datasetId: string, name: string, extra: Record<string, unknown> = {}) {
  return (
    await agent
      .post('/api/v1/experiments/local')
      .send({ dataset_id: datasetId, name, model: 'glm-5.3', ...extra })
      .expect(201)
  ).body as {
    experiment_id: string;
    run_id: string;
    cell_key: string;
    url: string | null;
    examples: Array<{ id: string; input: { message: string }; criteria: string | null; expected: unknown }>;
  };
}

/** Builds one result per example from a per-message `[totalExact, itemsScore]` table. */
function results(
  examples: Array<{ id: string; input: { message: string } }>,
  table: Record<string, [boolean, number] | 'error'>,
) {
  return examples.map((e) => {
    const row = table[e.input.message];
    if (row === 'error') return { example_id: e.id, error: 'TimeoutError: model took too long' };
    return {
      example_id: e.id,
      output: { total: row[0] ? 8 : 0 },
      scores: [
        { name: 'items_exact', score: row[1] }, // no `passed`: the server derives score >= 50
        { name: 'total_exact', score: row[0] ? 100 : 0, passed: row[0], reason: row[0] ? null : 'total differs' },
      ],
    };
  });
}

describe('local experiments (phase-5 FAQ Q46)', () => {
  it('runs a local experiment end to end: create → upload → retry → finish → list, report, cell, compare', async () => {
    const { agent, teamId, datasetId } = await arrange();

    // Create: the run starts running, and the frozen examples come back with `expected`.
    const v1 = await startLocal(agent, datasetId, 'v1', { primary_score: 'total_exact', metadata: { git_sha: 'abc123' } });
    expect(v1.cell_key).toBe('v1|glm-5.3');
    expect(v1.url).toMatch(new RegExp(`^https?://[^/]+/evaluations/runs/${v1.run_id}$`));
    expect(v1.examples).toHaveLength(3);
    const byMessage = Object.fromEntries(v1.examples.map((e) => [e.input.message, e]));
    expect(byMessage['two coffees'].expected).toEqual({ total: 8 });
    expect(byMessage['one tea'].criteria).toBe('Be polite.');
    expect(byMessage['nothing'].expected).toBeNull();

    const runRow = await prisma.experimentRun.findUniqueOrThrow({ where: { id: v1.run_id }, include: { experiment: true } });
    expect(runRow.status).toBe('running');
    expect(runRow.startedAt).not.toBeNull();
    expect(runRow.experiment.name).toBe('v1');
    expect(runRow.experiment.promptId).toBeNull();
    expect(runRow.experiment.config).toEqual({ kind: 'local', model: 'glm-5.3', primaryScore: 'total_exact', metadata: { git_sha: 'abc123' } });

    // Upload, then upload the same batch again: a retry replaces, never duplicates.
    const batch = results(v1.examples, { 'two coffees': [true, 100], 'one tea': [false, 40], nothing: 'error' });
    const first = await agent.post(`/api/v1/runs/${v1.run_id}/results`).send({ results: batch }).expect(200);
    expect(first.body).toEqual({ written: 3, completed: 3, total: 3 });
    await agent.post(`/api/v1/runs/${v1.run_id}/results`).send({ results: batch }).expect(200);

    const rows = await prisma.evalResult.findMany({ where: { experimentRunId: v1.run_id } });
    expect(rows).toHaveLength(3);
    const coffee = rows.find((r) => r.datasetExampleId === byMessage['two coffees'].id)!;
    // The primary score (total_exact) fills the columns every existing reader uses.
    expect(coffee).toMatchObject({ variantKind: 'local', variantLabel: 'v1', model: 'glm-5.3', score: 100, passed: true, teamId });
    expect(coffee.scores).toEqual([
      { name: 'items_exact', score: 100, passed: true, reason: null },
      { name: 'total_exact', score: 100, passed: true, reason: null },
    ]);
    const tea = rows.find((r) => r.datasetExampleId === byMessage['one tea'].id)!;
    expect(tea).toMatchObject({ score: 0, passed: false, reason: 'total differs' });
    expect((tea.scores as Array<{ name: string; passed: boolean }>)[0]).toMatchObject({ name: 'items_exact', passed: false });
    const nothing = rows.find((r) => r.datasetExampleId === byMessage['nothing'].id)!;
    expect(nothing).toMatchObject({ errorMessage: 'TimeoutError: model took too long', output: null, score: null, passed: null });

    // Finish: one errored example of three still succeeds.
    const finished = await agent.post(`/api/v1/runs/${v1.run_id}/finish`).send({}).expect(200);
    expect(finished.body).toMatchObject({ id: v1.run_id, kind: 'local', status: 'succeeded', results: { total: 3, succeeded: 2, errored: 1 } });
    expect(finished.body.endedAt).not.toBeNull();

    // A finished run takes no more results.
    const late = await agent.post(`/api/v1/runs/${v1.run_id}/results`).send({ results: batch.slice(0, 1) }).expect(409);
    expect(late.body.error.code).toBe('RUN_NOT_RUNNING');

    // The history list labels it local.
    const list = await agent.get(`/api/v1/runs?dataset_id=${datasetId}`).expect(200);
    expect(list.body.data[0]).toMatchObject({ id: v1.run_id, kind: 'local', experimentName: 'v1', promptId: null, avgScore: 50, passRate: 0.5 });

    // The report aggregates each named score per cell.
    const report = await agent.get(`/api/v1/runs/${v1.run_id}/report`).expect(200);
    expect(report.body.variants).toEqual([
      { variantKind: 'local', promptVersionId: null, variantLabel: 'v1', versionNumber: null, isProductionBaseline: false },
    ]);
    expect(report.body.cells[0].namedScores).toEqual([
      { name: 'items_exact', avgScore: 70, passRate: 0.5, scoredCount: 2 },
      { name: 'total_exact', avgScore: 50, passRate: 0.5, scoredCount: 2 },
    ]);

    // The cell drill-down carries every named score and the expected value.
    const cell = await agent.get(`/api/v1/runs/${v1.run_id}/cells/${encodeURIComponent(v1.cell_key)}`).expect(200);
    const coffeeCell = cell.body.examples.find((e: { exampleId: string }) => e.exampleId === byMessage['two coffees'].id);
    expect(coffeeCell).toMatchObject({ expected: { total: 8 }, score: 100, output: { total: 8 } });
    expect(coffeeCell.scores.map((s: { name: string }) => s.name)).toEqual(['items_exact', 'total_exact']);

    // A second run of the changed app, compared per example against the first.
    const v2 = await startLocal(agent, datasetId, 'v2', { primary_score: 'total_exact' });
    await agent
      .post(`/api/v1/runs/${v2.run_id}/results`)
      .send({ results: results(v2.examples, { 'two coffees': [false, 100], 'one tea': [true, 100], nothing: [true, 100] }) })
      .expect(200);
    await agent.post(`/api/v1/runs/${v2.run_id}/finish`).send({}).expect(200);

    const compare = await agent
      .get(`/api/v1/runs/${v1.run_id}/compare`)
      .query({ base_cell: v1.cell_key, target_cell: v2.cell_key, target_run_id: v2.run_id })
      .expect(200);
    expect(compare.body.score).toBeNull();
    expect(compare.body.scoreNames).toEqual(['items_exact', 'total_exact']);
    // On total_exact (the primary): coffee pass→fail, tea fail→pass, nothing errored→pass.
    expect(compare.body.counts).toEqual({ improved: 1, regressed: 1, unchanged: 0, unscored: 1, missing: 0 });

    const byItems = await agent
      .get(`/api/v1/runs/${v1.run_id}/compare`)
      .query({ base_cell: v1.cell_key, target_cell: v2.cell_key, target_run_id: v2.run_id, score: 'items_exact' })
      .expect(200);
    // On items_exact: coffee pass→pass, tea fail(40)→pass(100).
    expect(byItems.body.score).toBe('items_exact');
    expect(byItems.body.counts).toEqual({ improved: 1, regressed: 0, unchanged: 1, unscored: 1, missing: 0 });
    const teaRow = byItems.body.examples.find((e: { exampleId: string }) => e.exampleId === byMessage['one tea'].id);
    expect(teaRow).toMatchObject({ change: 'improved', scoreDelta: 60, expected: { total: 3 } });
    expect(teaRow.base.scores).toHaveLength(2);

    await agent
      .get(`/api/v1/runs/${v1.run_id}/compare`)
      .query({ base_cell: v1.cell_key, target_cell: v2.cell_key, target_run_id: v2.run_id, score: 'nope' })
      .expect(404);
  });

  it('fails a run on finish when every example errored, or when the SDK reports an error', async () => {
    const { agent, datasetId } = await arrange();

    const allErrored = await startLocal(agent, datasetId, 'broken');
    await agent
      .post(`/api/v1/runs/${allErrored.run_id}/results`)
      .send({ results: allErrored.examples.map((e) => ({ example_id: e.id, error: 'KeyError: total' })) })
      .expect(200);
    const failed = await agent.post(`/api/v1/runs/${allErrored.run_id}/finish`).send({}).expect(200);
    expect(failed.body).toMatchObject({ status: 'failed', error: 'Every one of the 3 examples failed in the task.' });

    const crashed = await startLocal(agent, datasetId, 'crashed');
    const reported = await agent
      .post(`/api/v1/runs/${crashed.run_id}/finish`)
      .send({ error: 'KeyboardInterrupt' })
      .expect(200);
    expect(reported.body).toMatchObject({ status: 'failed', error: 'KeyboardInterrupt' });

    const again = await agent.post(`/api/v1/runs/${crashed.run_id}/finish`).send({}).expect(409);
    expect(again.body.error.code).toBe('RUN_NOT_RUNNING');
  });

  it('rejects bad writes: unknown or repeated example, a server-side run, an empty dataset, and starting a local experiment on the server', async () => {
    const { agent, datasetId } = await arrange();
    const run = await startLocal(agent, datasetId, 'v1');

    const unknown = await agent
      .post(`/api/v1/runs/${run.run_id}/results`)
      .send({ results: [{ example_id: '00000000-0000-4000-8000-000000000000', output: 1 }] })
      .expect(400);
    expect(unknown.body.error.message).toContain('is not an example of this run');

    const repeated = await agent
      .post(`/api/v1/runs/${run.run_id}/results`)
      .send({ results: [{ example_id: run.examples[0].id, output: 1 }, { example_id: run.examples[0].id, output: 2 }] })
      .expect(400);
    expect(repeated.body.error.message).toContain('appears twice');

    const badScore = await agent
      .post(`/api/v1/runs/${run.run_id}/results`)
      .send({ results: [{ example_id: run.examples[0].id, output: 1, scores: [{ name: 'x', score: 1.5e3 }] }] })
      .expect(400);
    expect(badScore.body.error.message).toMatch(/^results\[0\]\.scores\[0\]\.score:/);

    await agent.post('/api/v1/experiments/local').send({ dataset_id: datasetId, name: 'a|b' }).expect(400);
    const empty = (await agent.post('/api/v1/datasets').send({ name: 'empty' }).expect(201)).body;
    await agent.post('/api/v1/experiments/local').send({ dataset_id: empty.id, name: 'v1' }).expect(400);

    // POST /experiments/:id/runs refuses a local experiment.
    const serverStart = await agent.post(`/api/v1/experiments/${run.experiment_id}/runs`).expect(409);
    expect(serverStart.body.error.code).toBe('LOCAL_EXPERIMENT');

    // A server-side run never accepts uploaded results.
    const conn = await agent
      .post('/api/v1/gateway/connections')
      .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
      .expect(201);
    await agent.post('/api/v1/gateway/models').send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id }).expect(201);
    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'reply' }).expect(201)).body;
    const version = (await agent.post(`/api/v1/prompts/${prompt.id}/versions`).send({ messages: [{ role: 'user', content: 'Reply to {{ message }}' }] }).expect(201)).body;
    const experiment = (
      await agent
        .post('/api/v1/experiments')
        .send({ dataset_id: datasetId, prompt_id: prompt.id, version_ids: [version.id], models: ['gpt-4o-mini'], judge_model: 'gpt-4o-mini' })
        .expect(201)
    ).body;
    const serverRun = (await agent.post(`/api/v1/experiments/${experiment.id}/runs`).expect(202)).body;
    const notLocal = await agent
      .post(`/api/v1/runs/${serverRun.run_id}/results`)
      .send({ results: [{ example_id: run.examples[0].id, output: 1 }] })
      .expect(409);
    expect(notLocal.body.error.code).toBe('RUN_NOT_LOCAL');
  });

  it("keeps another team's run and dataset out of reach", async () => {
    const a = await arrange();
    const b = await arrange();
    const run = await startLocal(a.agent, a.datasetId, 'v1');

    await b.agent.post('/api/v1/experiments/local').send({ dataset_id: a.datasetId, name: 'v1' }).expect(404);
    await b.agent
      .post(`/api/v1/runs/${run.run_id}/results`)
      .send({ results: [{ example_id: run.examples[0].id, output: 1 }] })
      .expect(404);
    await b.agent.post(`/api/v1/runs/${run.run_id}/finish`).send({}).expect(404);
    expect(await prisma.evalResult.count({ where: { experimentRunId: run.run_id } })).toBe(0);
  });

  describe('PR #602 review fixes', () => {
    it('stores one row per example when the same batch is uploaded several times at once (a retry racing the first try)', async () => {
      const { agent, datasetId } = await arrange();
      const run = await startLocal(agent, datasetId, 'v1');
      const batch = results(run.examples, { 'two coffees': [true, 100], 'one tea': [false, 40], nothing: 'error' });

      const codes = await Promise.all(
        Array.from({ length: 8 }, () => agent.post(`/api/v1/runs/${run.run_id}/results`).send({ results: batch }).then((r) => r.status)),
      );
      expect(codes).toEqual(Array(8).fill(200));
      expect(await prisma.evalResult.count({ where: { experimentRunId: run.run_id } })).toBe(3);
    });

    it("returns each frozen example's history, so a local task can replay the earlier turns", async () => {
      const { agent } = await authedAgent(app);
      const dataset = (await agent.post('/api/v1/datasets').send({ name: 'chat' }).expect(201)).body;
      const history = [
        { role: 'user', content: 'list two colours' },
        { role: 'assistant', content: 'red, blue' },
      ];
      await agent
        .post(`/api/v1/datasets/${dataset.id}/examples/bulk`)
        .send({ examples: [{ input: { q: 'and the second one?' }, history }, { input: { q: 'hi' } }] })
        .expect(201);

      const run = await startLocal(agent, dataset.id, 'v1');
      const byQ = Object.fromEntries(run.examples.map((e) => [(e.input as unknown as { q: string }).q, e]));
      expect((byQ['and the second one?'] as unknown as { history: unknown }).history).toEqual(history);
      expect((byQ['hi'] as unknown as { history: unknown }).history).toBeNull();
    });

    it('stores an errored result with SQL NULL output, as a server-side errored cell does', async () => {
      const { agent, datasetId } = await arrange();
      const run = await startLocal(agent, datasetId, 'v1');
      await agent
        .post(`/api/v1/runs/${run.run_id}/results`)
        .send({ results: [{ example_id: run.examples[0].id, output: null, error: 'KeyError: total', scores: [] }] })
        .expect(200);

      const rows = await prisma.$queryRaw<Array<{ sql_null: boolean }>>`
        SELECT output IS NULL AS sql_null FROM eval_results WHERE experiment_run_id = ${run.run_id}::uuid`;
      expect(rows).toEqual([{ sql_null: true }]);
    });

    it('stores named scores as whole numbers, so the matrix and the Scores table agree on the primary score', async () => {
      const { agent, datasetId } = await arrange();
      const run = await startLocal(agent, datasetId, 'v1');
      await agent
        .post(`/api/v1/runs/${run.run_id}/results`)
        .send({
          results: run.examples.map((e) => ({ example_id: e.id, output: 1, scores: [{ name: 'third', score: 33.3333 }] })),
        })
        .expect(200);

      const report = (await agent.get(`/api/v1/runs/${run.run_id}/report`).expect(200)).body;
      const cell = report.cells[0];
      expect(cell.avgScore).toBe(33);
      expect(cell.namedScores).toEqual([{ name: 'third', avgScore: 33, passRate: 0, scoredCount: 3 }]);
    });

    it('rejects a result that lacks the named primary score, instead of storing it as unscored', async () => {
      const { agent, datasetId } = await arrange();
      const run = await startLocal(agent, datasetId, 'v1', { primary_score: 'quality' });
      const res = await agent
        .post(`/api/v1/runs/${run.run_id}/results`)
        .send({ results: [{ example_id: run.examples[0].id, output: 1, scores: [{ name: 'accuracy', score: 100 }] }] })
        .expect(400);
      expect(res.body.error.message).toContain('no score named "quality", the run\'s primary score');
      expect(res.body.error.message).toContain('accuracy');

      // A result with no scores at all (the task errored) is still accepted.
      await agent
        .post(`/api/v1/runs/${run.run_id}/results`)
        .send({ results: [{ example_id: run.examples[1].id, error: 'boom' }] })
        .expect(200);
    });

    it('answers an unknown compare score with its own error code, not the unknown-cell one', async () => {
      const { agent, datasetId } = await arrange();
      const v1 = await startLocal(agent, datasetId, 'v1');
      await agent.post(`/api/v1/runs/${v1.run_id}/results`).send({ results: results(v1.examples, { 'two coffees': [true, 100], 'one tea': [false, 40], nothing: 'error' }) }).expect(200);
      await agent.post(`/api/v1/runs/${v1.run_id}/finish`).send({}).expect(200);
      const res = await agent
        .get(`/api/v1/runs/${v1.run_id}/compare`)
        .query({ base_cell: v1.cell_key, target_cell: v1.cell_key, score: 'nope' })
        .expect(404);
      expect(res.body.error.code).toBe('SCORE_NOT_FOUND');
    });
  });

  // phase-5 FAQ Q59: a local run on a dataset built from feedback is graded by the
  // same judge, against the same criteria and overall feedback, as an optimize run.
  describe('POST /runs/:id/judge', () => {
    // Restored here, not after the request: a failed assertion would skip an inline
    // restore and leave the fake judge answering every later test.
    afterEach(() => jest.restoreAllMocks());

    it('grades a local output against the frozen criteria and overall feedback, and stores nothing', async () => {
      const { agent } = await authedAgent(app);
      const conn = await agent
        .post('/api/v1/gateway/connections')
        .send({ provider: 'openai', label: 'judge', apiKey: 'sk-test-000000000000AB12', config: {} })
        .expect(201);
      await agent
        .post('/api/v1/gateway/models')
        .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id })
        .expect(201);
      const dataset = (
        await agent
          .post('/api/v1/datasets')
          .send({ name: 'routing', overall_feedback: 'Tone never sets the priority.' })
          .expect(201)
      ).body;
      await agent
        .post(`/api/v1/datasets/${dataset.id}/examples`)
        .send({ input: { ticket: 'Locked out of my account' }, criteria: 'Correct answer: account, P0.' })
        .expect(201);
      const run = await startLocal(agent, dataset.id, 'candidate');
      // Edited after the run started: the judge must still read the frozen text.
      await agent.patch(`/api/v1/datasets/${dataset.id}`).send({ overall_feedback: 'changed later' }).expect(200);

      let judgeMessages = '';
      jest.spyOn(global, 'fetch').mockImplementation((_url, init) => {
        judgeMessages = typeof init?.body === 'string' ? init.body : '';
        const content = JSON.stringify({ score: 90, passed: true, reason: 'account and P0, as required' });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'chatcmpl-judge',
              object: 'chat.completion',
              created: 1751536800,
              model: 'gpt-4o-mini',
              choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      });

      const res = await agent
        .post(`/api/v1/runs/${run.run_id}/judge`)
        .send({ example_id: run.examples[0].id, output: { category: 'account', priority: 'P0' }, model: 'gpt-4o-mini' })
        .expect(200);

      expect(res.body).toEqual({
        score: 90,
        passed: true,
        reason: 'account and P0, as required',
        judge_trace_id: expect.any(String),
      });
      expect(judgeMessages).toContain('Correct answer: account, P0.');
      expect(judgeMessages).toContain('Tone never sets the priority.');
      expect(judgeMessages).not.toContain('changed later');
      expect(judgeMessages).toContain('P0');
      // Grading is a read: the result is uploaded later as one of the scorer's scores.
      expect(await prisma.evalResult.count({ where: { experimentRunId: run.run_id } })).toBe(0);
    });

    it('keeps grading with the judge prompt version the run first used, after a newer one is promoted', async () => {
      const { agent } = await authedAgent(app);
      const conn = await agent
        .post('/api/v1/gateway/connections')
        .send({ provider: 'openai', label: 'judge', apiKey: 'sk-test-000000000000AB12', config: {} })
        .expect(201);
      await agent
        .post('/api/v1/gateway/models')
        .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id })
        .expect(201);
      const dataset = (await agent.post('/api/v1/datasets').send({ name: 'routing' }).expect(201)).body;
      await agent
        .post(`/api/v1/datasets/${dataset.id}/examples/bulk`)
        .send({ examples: [{ input: { ticket: 'a' }, criteria: 'P0.' }, { input: { ticket: 'b' }, criteria: 'P1.' }] })
        .expect(201);
      const judgePrompt = (await agent.post('/api/v1/prompts').send({ name: 'house-judge' }).expect(201)).body;
      await agent
        .post(`/api/v1/prompts/${judgePrompt.id}/versions`)
        .send({ messages: [{ role: 'user', content: 'RUBRIC-ONE {{ criteria }} {{ output }}' }] })
        .expect(201);
      const run = await startLocal(agent, dataset.id, 'candidate');

      const sent: string[] = [];
      jest.spyOn(global, 'fetch').mockImplementation((_url, init) => {
        sent.push(typeof init?.body === 'string' ? init.body : '');
        const content = JSON.stringify({ score: 90, passed: true, reason: 'ok' });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'chatcmpl-judge',
              object: 'chat.completion',
              created: 1751536800,
              model: 'gpt-4o-mini',
              choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      });
      const judge = (exampleId: string) =>
        agent
          .post(`/api/v1/runs/${run.run_id}/judge`)
          .send({ example_id: exampleId, output: 'P0', model: 'gpt-4o-mini', judge_prompt_id: judgePrompt.id })
          .expect(200);

      await judge(run.examples[0].id);
      // Promoted mid-run: the rest of the run must not switch rubric.
      await agent
        .post(`/api/v1/prompts/${judgePrompt.id}/versions`)
        .send({ messages: [{ role: 'user', content: 'RUBRIC-TWO {{ criteria }} {{ output }}' }] })
        .expect(201);
      await agent.post(`/api/v1/prompts/${judgePrompt.id}/aliases/production/promote`).send({ version_number: 2 }).expect(200);
      await judge(run.examples[1].id);

      expect(sent).toHaveLength(2);
      expect(sent[0]).toContain('RUBRIC-ONE');
      expect(sent[1]).toContain('RUBRIC-ONE');
      expect(sent[1]).not.toContain('RUBRIC-TWO');
    });

    it('grades with the judge prompt version the caller names, in every run, whatever production serves', async () => {
      const { agent } = await authedAgent(app);
      const conn = await agent
        .post('/api/v1/gateway/connections')
        .send({ provider: 'openai', label: 'judge', apiKey: 'sk-test-000000000000AB12', config: {} })
        .expect(201);
      await agent
        .post('/api/v1/gateway/models')
        .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id })
        .expect(201);
      const dataset = (await agent.post('/api/v1/datasets').send({ name: 'routing' }).expect(201)).body;
      await agent
        .post(`/api/v1/datasets/${dataset.id}/examples`)
        .send({ input: { ticket: 'a' }, criteria: 'P0.' })
        .expect(201);
      const judgePrompt = (await agent.post('/api/v1/prompts').send({ name: 'house-judge' }).expect(201)).body;
      for (const rubric of ['RUBRIC-ONE', 'RUBRIC-TWO']) {
        await agent
          .post(`/api/v1/prompts/${judgePrompt.id}/versions`)
          .send({ messages: [{ role: 'user', content: `${rubric} {{ criteria }} {{ output }}` }] })
          .expect(201);
      }
      // The optimize run graded with v1; production has moved on to v2 since.
      await agent.post(`/api/v1/prompts/${judgePrompt.id}/aliases/production/promote`).send({ version_number: 2 }).expect(200);
      const production = await startLocal(agent, dataset.id, 'production');
      const candidate = await startLocal(agent, dataset.id, 'candidate-B');

      const sent: string[] = [];
      jest.spyOn(global, 'fetch').mockImplementation((_url, init) => {
        sent.push(typeof init?.body === 'string' ? init.body : '');
        const content = JSON.stringify({ score: 90, passed: true, reason: 'ok' });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'chatcmpl-judge',
              object: 'chat.completion',
              created: 1751536800,
              model: 'gpt-4o-mini',
              choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      });
      const judge = (run: { run_id: string; examples: Array<{ id: string }> }, extra: Record<string, unknown>) =>
        agent
          .post(`/api/v1/runs/${run.run_id}/judge`)
          .send({ example_id: run.examples[0].id, output: 'P0', model: 'gpt-4o-mini', judge_prompt_id: judgePrompt.id, ...extra });

      await judge(production, { judge_prompt_version: 1 }).expect(200);
      await judge(candidate, { judge_prompt_version: 1 }).expect(200);
      expect(sent).toHaveLength(2);
      expect(sent.every((body) => body.includes('RUBRIC-ONE'))).toBe(true);

      // A run graded with v1 cannot switch to v2 halfway: its scores would mix two rubrics.
      const mixed = await judge(candidate, { judge_prompt_version: 2 }).expect(409);
      expect(mixed.body.error.code).toBe('JUDGE_PROMPT_VERSION_MISMATCH');

      const unknown = await judge(candidate, { judge_prompt_version: 9 }).expect(400);
      expect(unknown.body.error.message).toContain('has no version 9');
      const orphan = await agent
        .post(`/api/v1/runs/${candidate.run_id}/judge`)
        .send({ example_id: candidate.examples[0].id, output: 'P0', model: 'gpt-4o-mini', judge_prompt_version: 1 })
        .expect(400);
      expect(orphan.body.error.message).toContain('judge_prompt_version needs judge_prompt_id');
      expect(sent).toHaveLength(2);
    });

    it('answers a malformed run id with 400, like the other run routes', async () => {
      const { agent } = await authedAgent(app);
      const res = await agent
        .post('/api/v1/runs/not-a-uuid/judge')
        .send({ example_id: '00000000-0000-4000-8000-000000000000', output: 'x', model: 'gpt-4o-mini' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('refuses a server-side run, an unknown example, and an unregistered judge model', async () => {
      const { agent, datasetId } = await arrange();
      const run = await startLocal(agent, datasetId, 'v1');

      const unknown = await agent
        .post(`/api/v1/runs/${run.run_id}/judge`)
        .send({ example_id: '00000000-0000-4000-8000-000000000000', output: 'x', model: 'gpt-4o-mini' })
        .expect(400);
      expect(unknown.body.error.message).toContain('is not an example of this run');

      const model = await agent
        .post(`/api/v1/runs/${run.run_id}/judge`)
        .send({ example_id: run.examples[0].id, output: 'x', model: 'not-registered' })
        .expect(400);
      expect(model.body.error.message).toContain("Model 'not-registered' is not registered");

      const missing = await agent
        .post(`/api/v1/runs/${run.run_id}/judge`)
        .send({ example_id: run.examples[0].id, output: 'x' })
        .expect(400);
      expect(missing.body.error.message).toContain('model is required');

      // What a server-side run looks like to this check: a grid with no local cell.
      const serverRun = await startLocal(agent, datasetId, 'v2');
      await prisma.experimentRun.update({
        where: { id: serverRun.run_id },
        data: { grid: [{ cellKey: 'v1|m', variantKind: 'version', variantLabel: 'v1', model: 'm', isProductionBaseline: true }] },
      });
      const conflict = await agent
        .post(`/api/v1/runs/${serverRun.run_id}/judge`)
        .send({ example_id: serverRun.examples[0].id, output: 'x', model: 'gpt-4o-mini' })
        .expect(409);
      expect(conflict.body.error.code).toBe('RUN_NOT_LOCAL');
    });
  });
});
