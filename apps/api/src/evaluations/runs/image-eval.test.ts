import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { RunsRepository } from './runs.repository';
import { UnrecoverableError } from 'bullmq';
import { processCell, processJudge } from './index';
import { isTerminalCellFailure } from './processors';
import { getFlowProducer, getRedisConnection, getCellsQueue, getRunsQueue, getJudgeQueue } from '../queue';
import { authedAgent } from '../../test-utils';

const app = createApp();
const runsRepo = new RunsRepository();

const RECEIPT_URL = 'https://example.com/receipts/blue-heron.png';

/** A user message that holds a text part and an image part whose URL is filled from a variable. */
const RECEIPT_MESSAGES: Array<{ role: string; content: unknown }> = [
  { role: 'system', content: 'You read receipts.' },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Read this {{ kind }}. Reply with the merchant and the total.' },
      { type: 'image_url', image_url: { url: '{{ receipt_url }}', detail: 'high' } },
    ],
  },
];

function completion(content: string): unknown {
  return {
    id: 'chatcmpl-img',
    object: 'chat.completion',
    created: 1751536800,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  };
}

/** Replies to every provider call with `bodies` in order, and records the JSON each call sent. */
function fakeProvider(...bodies: unknown[]): Array<Record<string, any>> {
  const sent: Array<Record<string, any>> = [];
  let i = 0;
  jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
    sent.push(JSON.parse((init as RequestInit).body as string));
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  });
  return sent;
}

async function truncateTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    eval_results, experiment_runs, experiments,
    dataset_examples, datasets,
    span_payloads, spans, trace_feedback, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys,
    gateway_model_fallbacks, gateway_models, provider_connections,
    prompt_aliases, prompt_versions, prompts,
    audit_log, api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
}

beforeEach(async () => {
  await truncateTables();
  await getJudgeQueue().obliterate({ force: true });
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
  await getFlowProducer().close();
  await getCellsQueue().close();
  await getRunsQueue().close();
  await getJudgeQueue().close();
  await getRedisConnection().quit();
});

/** Registers a model and commits the receipt prompt as v1 promoted to production. */
async function arrange(agent: ReturnType<typeof request.agent>) {
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id })
    .expect(201);
  const prompt = (await agent.post('/api/v1/prompts').send({ name: 'receipt-reader' }).expect(201)).body;
  const version = (
    await agent.post(`/api/v1/prompts/${prompt.id}/versions`).send({ messages: RECEIPT_MESSAGES }).expect(201)
  ).body;
  await agent.post(`/api/v1/prompts/${prompt.id}/aliases/production/promote`).send({ version_number: 1 }).expect(200);
  return { promptId: prompt.id as string, versionId: version.id as string };
}

describe('image parts in a stored prompt version (issue #573)', () => {
  it('commits a version with an image part, lists the variables of its text and its URL, and returns it unchanged', async () => {
    const { agent } = await authedAgent(app);
    const { promptId } = await arrange(agent);

    const got = await agent.get(`/api/v1/prompts/${promptId}/versions/1`).expect(200);

    expect(got.body.variables).toEqual(['kind', 'receipt_url']);
    expect(got.body.messages[1].content).toEqual(RECEIPT_MESSAGES[1]!.content);
    const row = await prisma.promptVersion.findFirstOrThrow({ where: { promptId } });
    expect(row.variables).toEqual(['kind', 'receipt_url']);
  });

  it.each([
    ['an image in a system message', [{ role: 'system', content: [{ type: 'image_url', image_url: { url: 'https://x.test/a.png' } }] }]],
    ['an unknown part type', [{ role: 'user', content: [{ type: 'audio', data: 'x' }] }]],
    ['an empty parts list', [{ role: 'user', content: [] }]],
    ['an image part with no url', [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }]],
  ])('rejects %s with 400', async (_label, messages) => {
    const { agent } = await authedAgent(app);
    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'bad-parts' }).expect(201)).body;

    await agent.post(`/api/v1/prompts/${prompt.id}/versions`).send({ messages }).expect(400);

    expect(await prisma.promptVersion.count({ where: { promptId: prompt.id } })).toBe(0);
  });

  it('renders the alias with the text and the image URL filled, and keeps the detail field', async () => {
    const { agent } = await authedAgent(app);
    await arrange(agent);

    const res = await agent
      .post('/api/v1/prompts/receipt-reader/production/render')
      .send({ variables: { kind: 'receipt', receipt_url: RECEIPT_URL } })
      .expect(200);

    expect(res.body.messages[1].content).toEqual([
      { type: 'text', text: 'Read this receipt. Reply with the merchant and the total.' },
      { type: 'image_url', image_url: { url: RECEIPT_URL, detail: 'high' } },
    ]);
  });

  it('answers 400 MISSING_VARIABLES when the variable that fills the image is not given', async () => {
    const { agent } = await authedAgent(app);
    await arrange(agent);

    const res = await agent
      .post('/api/v1/prompts/receipt-reader/production/render')
      .send({ variables: { kind: 'receipt' } })
      .expect(400);

    expect(res.body.error.code).toBe('MISSING_VARIABLES');
    expect(JSON.stringify(res.body)).toContain('receipt_url');
  });

  it('shows a changed image in the diff between two versions', async () => {
    const { agent } = await authedAgent(app);
    const { promptId } = await arrange(agent);
    const v2 = RECEIPT_MESSAGES.map((m) => ({ ...m }));
    v2[1] = { role: 'user', content: [{ type: 'image_url', image_url: { url: '{{ other_url }}' } }] };
    await agent.post(`/api/v1/prompts/${promptId}/versions`).send({ messages: v2 }).expect(201);

    const res = await agent.get(`/api/v1/prompts/${promptId}/versions/diff?from=1&to=2`).expect(200);

    expect(res.body.diff).toContain('[image: {{ receipt_url }}]');
    expect(res.body.diff).toContain('[image: {{ other_url }}]');
  });

  it('sends the rendered image part to the model when a gateway call names the prompt', async () => {
    const { agent } = await authedAgent(app);
    await arrange(agent);
    const sent = fakeProvider(completion('BLUE HERON CAFE 12.50'));

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'gpt-4o-mini',
        prompt: { name: 'receipt-reader', alias: 'production', variables: { kind: 'receipt', receipt_url: RECEIPT_URL } },
      })
      .expect(200);

    expect(res.body.choices[0].message.content).toBe('BLUE HERON CAFE 12.50');
    expect(sent[0]!['messages'][1].content).toEqual([
      { type: 'text', text: 'Read this receipt. Reply with the merchant and the total.' },
      { type: 'image_url', image_url: { url: RECEIPT_URL, detail: 'high' } },
    ]);
  });

  it('fills the image URL of an ad-hoc message from variables', async () => {
    const { agent } = await authedAgent(app);
    await arrange(agent);
    const sent = fakeProvider(completion('ok'));

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'gpt-4o-mini',
        variables: { u: RECEIPT_URL },
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: '{{ u }}' } }] }],
      })
      .expect(200);

    expect(sent[0]!['messages'][0].content).toEqual([{ type: 'image_url', image_url: { url: RECEIPT_URL } }]);
  });

  it('answers 400, and calls no provider, when an ad-hoc image URL is a template and no variable fills it', async () => {
    const { agent } = await authedAgent(app);
    await arrange(agent);
    const sent = fakeProvider(completion('never used'));

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: '{{ u }}' } }] }] })
      .expect(400);

    expect(res.body.error.message).toMatch(/not an http\(s\) URL/);
    expect(sent).toHaveLength(0);
  });

  it('answers 400, and calls no provider, when the variable that fills the image is not a usable URL', async () => {
    const { agent } = await authedAgent(app);
    await arrange(agent);
    const sent = fakeProvider(completion('never used'));

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'gpt-4o-mini',
        prompt: { name: 'receipt-reader', alias: 'production', variables: { kind: 'receipt', receipt_url: 'blue-heron.png' } },
      })
      .expect(400);

    expect(res.body.error.message).toMatch(/not an http\(s\) URL/);
    expect(sent).toHaveLength(0);
  });
});

describe('an eval over a prompt with an image (issue #573)', () => {
  /** A one-example run: the example holds the receipt URL as an ordinary variable. */
  async function arrangeRun(teamId: string, agent: ReturnType<typeof request.agent>, receiptUrl: string, criteria: string | null) {
    const { promptId, versionId } = await arrange(agent);
    const dataset = (await agent.post('/api/v1/datasets').send({ name: 'receipts' }).expect(201)).body;
    const example = (
      await agent
        .post(`/api/v1/datasets/${dataset.id}/examples`)
        .send({ input: { kind: 'receipt', receipt_url: receiptUrl }, ...(criteria ? { criteria } : {}) })
        .expect(201)
    ).body;
    const experiment = (
      await agent
        .post('/api/v1/experiments')
        .send({ dataset_id: dataset.id, prompt_id: promptId, version_ids: [versionId], models: ['gpt-4o-mini'], judge_model: 'gpt-4o-mini' })
        .expect(201)
    ).body;
    const run = await runsRepo.createRun(teamId, experiment.id, {
      exampleSnapshot: [{ exampleId: example.id, input: { kind: 'receipt', receipt_url: receiptUrl }, criteria }],
      grid: [{ cellKey: 'v1|gpt-4o-mini', variantKind: 'version', promptVersionId: versionId, versionLabel: 'v1', model: 'gpt-4o-mini' }],
    });
    const cell = {
      teamId,
      runId: run.id,
      cellKey: 'v1|gpt-4o-mini',
      variantKind: 'version' as const,
      promptVersionId: versionId,
      variantLabel: 'v1',
      model: 'gpt-4o-mini',
      exampleId: example.id as string,
      judgeModel: 'gpt-4o-mini',
    };
    return { run, cell };
  }

  it('shows the model the image from the example, then shows the same image to the judge', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { run, cell } = await arrangeRun(teamId, agent, RECEIPT_URL, 'The total must be 12.50.');
    const sent = fakeProvider(
      completion('BLUE HERON CAFE 12.50'),
      completion(JSON.stringify({ score: 100, passed: true, reason: 'The total matches the receipt.' })),
    );

    await processCell(cell);

    expect(sent[0]!['messages'][1].content[1]).toEqual({ type: 'image_url', image_url: { url: RECEIPT_URL, detail: 'high' } });

    // The cell queued a judge job that carries the image.
    const [job] = await getJudgeQueue().getJobs(['waiting', 'delayed']);
    expect(job!.data.images).toEqual([{ type: 'image_url', image_url: { url: RECEIPT_URL, detail: 'high' } }]);

    const result = await prisma.evalResult.findFirstOrThrow({ where: { experimentRunId: run.id } });
    await processJudge(job!.data);

    const judgeMessage = sent[1]!['messages'][1];
    expect(Array.isArray(judgeMessage.content)).toBe(true);
    expect(judgeMessage.content[0].text).toContain('BLUE HERON CAFE 12.50');
    expect(judgeMessage.content[0].text).toContain('source material');
    expect(judgeMessage.content[1]).toEqual({ type: 'image_url', image_url: { url: RECEIPT_URL, detail: 'high' } });

    const judged = await prisma.evalResult.findUniqueOrThrow({ where: { id: result.id } });
    expect(judged.score).toBe(100);
  });

  it("shows the image to a custom judge prompt too, after the template's last user message (issue #578)", async () => {
    const { agent, teamId } = await authedAgent(app);
    const { run, cell } = await arrangeRun(teamId, agent, RECEIPT_URL, 'Expected company BLUE HERON CAFE, total 12.50.');
    const judgePrompt = (await agent.post('/api/v1/prompts').send({ name: 'receipt judge' }).expect(201)).body;
    const judgeVersion = (
      await agent
        .post(`/api/v1/prompts/${judgePrompt.id}/versions`)
        .send({
          messages: [
            { role: 'system', content: 'Ignore formatting differences. Expected: {{ criteria }}' },
            { role: 'user', content: 'Extracted: {{ output }}' },
          ],
        })
        .expect(201)
    ).body;
    const sent = fakeProvider(
      completion('BLUE HERON CAFE 12.50'),
      completion(JSON.stringify({ score: 100, passed: true, reason: 'Matches the receipt.' })),
    );

    await processCell({ ...cell, judgePromptVersionId: judgeVersion.id });
    const [job] = await getJudgeQueue().getJobs(['waiting', 'delayed']);
    expect(job!.data.judgePromptVersionId).toBe(judgeVersion.id);
    await processJudge(job!.data);

    const judgeMessages = sent[1]!['messages'];
    expect(judgeMessages[0]).toEqual({
      role: 'system',
      content: 'Ignore formatting differences. Expected: Expected company BLUE HERON CAFE, total 12.50.',
    });
    expect(judgeMessages[1].role).toBe('user');
    expect(judgeMessages[1].content[0].text).toBe('Extracted: BLUE HERON CAFE 12.50');
    expect(judgeMessages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: RECEIPT_URL, detail: 'high' } });
    const judged = await prisma.evalResult.findFirstOrThrow({ where: { experimentRunId: run.id } });
    expect(judged.score).toBe(100);
  });

  it('sends a text-only judge prompt, with no image note, when the prompt has no image', async () => {
    const { agent, teamId } = await authedAgent(app);
    const conn = await agent
      .post('/api/v1/gateway/connections')
      .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
      .expect(201);
    await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id })
      .expect(201);
    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'plain' }).expect(201)).body;
    const version = (
      await agent.post(`/api/v1/prompts/${prompt.id}/versions`).send({ messages: [{ role: 'user', content: 'Hi {{ name }}' }] }).expect(201)
    ).body;
    const dataset = (await agent.post('/api/v1/datasets').send({ name: 'plain' }).expect(201)).body;
    const example = (
      await agent.post(`/api/v1/datasets/${dataset.id}/examples`).send({ input: { name: 'Al' }, criteria: 'Greets Al.' }).expect(201)
    ).body;
    const experiment = (
      await agent
        .post('/api/v1/experiments')
        .send({ dataset_id: dataset.id, prompt_id: prompt.id, version_ids: [version.id], models: ['gpt-4o-mini'], judge_model: 'gpt-4o-mini' })
        .expect(201)
    ).body;
    const run = await runsRepo.createRun(teamId, experiment.id, {
      exampleSnapshot: [{ exampleId: example.id, input: { name: 'Al' }, criteria: 'Greets Al.' }],
      grid: [{ cellKey: 'v1|gpt-4o-mini', variantKind: 'version', promptVersionId: version.id, versionLabel: 'v1', model: 'gpt-4o-mini' }],
    });
    const sent = fakeProvider(
      completion('Hi Al'),
      completion(JSON.stringify({ score: 90, passed: true, reason: 'ok' })),
    );

    await processCell({
      teamId,
      runId: run.id,
      cellKey: 'v1|gpt-4o-mini',
      variantKind: 'version',
      promptVersionId: version.id,
      variantLabel: 'v1',
      model: 'gpt-4o-mini',
      exampleId: example.id,
      judgeModel: 'gpt-4o-mini',
    });
    const [job] = await getJudgeQueue().getJobs(['waiting', 'delayed']);
    expect(job!.data.images).toBeUndefined();
    await processJudge(job!.data);

    expect(typeof sent[1]!['messages'][1].content).toBe('string');
    expect(sent[1]!['messages'][1].content).not.toContain('source material');
  });

  it('fails the cell with a clear message, and calls no provider, when the example holds no usable image URL', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { cell } = await arrangeRun(teamId, agent, 'blue-heron.png', null);
    const sent = fakeProvider(completion('never used'));

    await expect(processCell(cell)).rejects.toThrow(/not an http\(s\) URL/);

    expect(sent).toHaveLength(0);
  });
});

describe('large and missing inline images (review of PR #574)', () => {
  it('sends a 2 MB data URL written into an ad-hoc message when the call also has variables', async () => {
    const { agent } = await authedAgent(app);
    await arrange(agent);
    const sent = fakeProvider(completion('ok'));
    const url = `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`;

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model: 'gpt-4o-mini',
        variables: { kind: 'receipt' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read this {{ kind }}.' },
              { type: 'image_url', image_url: { url } },
            ],
          },
        ],
      })
      .expect(200);

    expect(sent[0]!['messages'][0].content[1].image_url.url).toBe(url);
  });

  it('skips a feedback row whose image variable a trace kept only as a placeholder, and says why', async () => {
    const { agent, teamId } = await authedAgent(app);
    await arrange(agent);
    fakeProvider(completion('BLUE HERON CAFE 12.50'));
    const inline = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-capture-payloads', 'true')
      .send({ model: 'gpt-4o-mini', prompt: { name: 'receipt-reader', alias: 'production', variables: { kind: 'receipt', receipt_url: inline } } })
      .expect(200);
    const trace = await prisma.trace.findFirstOrThrow({ where: { teamId } });
    const fb = (await agent.post(`/api/v1/traces/${trace.id}/feedback`).send({ rating: -1, comment: 'Wrong total' }).expect(201)).body;
    const dataset = (await agent.post('/api/v1/datasets').send({ name: 'receipts' }).expect(201)).body;

    const res = await agent
      .post(`/api/v1/datasets/${dataset.id}/examples/from-feedback`)
      .send({ feedback_ids: [fb.id] })
      .expect(200);

    expect(res.body.added).toBe(0);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].reason).toContain('receipt_url');
    expect(res.body.skipped[0].reason).toContain('inline image');
    expect(await prisma.datasetExample.count({ where: { datasetId: dataset.id } })).toBe(0);
  });

  it('fails a cell at once, with a message that names the cause, when the example holds an image placeholder', async () => {
    const { agent, teamId } = await authedAgent(app);
    const { promptId, versionId } = await arrange(agent);
    const input = { kind: 'receipt', receipt_url: '[image omitted: image/png, 70 bytes]' };
    const dataset = (await agent.post('/api/v1/datasets').send({ name: 'receipts' }).expect(201)).body;
    const example = (await agent.post(`/api/v1/datasets/${dataset.id}/examples`).send({ input }).expect(201)).body;
    const experiment = (
      await agent
        .post('/api/v1/experiments')
        .send({ dataset_id: dataset.id, prompt_id: promptId, version_ids: [versionId], models: ['gpt-4o-mini'], judge_model: 'gpt-4o-mini' })
        .expect(201)
    ).body;
    const run = await runsRepo.createRun(teamId, experiment.id, {
      exampleSnapshot: [{ exampleId: example.id, input, criteria: null }],
      grid: [{ cellKey: 'v1|gpt-4o-mini', variantKind: 'version', promptVersionId: versionId, versionLabel: 'v1', model: 'gpt-4o-mini' }],
    });
    const sent = fakeProvider(completion('never used'));

    const failure = await processCell({
      teamId,
      runId: run.id,
      cellKey: 'v1|gpt-4o-mini',
      variantKind: 'version',
      promptVersionId: versionId,
      variantLabel: 'v1',
      model: 'gpt-4o-mini',
      exampleId: example.id,
    }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(UnrecoverableError);
    expect((failure as Error).message).toContain('This example has no image to send.');
    expect((failure as Error).message).toContain('put a public image link in that variable');
    expect(sent).toHaveLength(0);
    // The worker writes the terminal error row for it on the first attempt, not after the retries.
    expect(isTerminalCellFailure(1, 3, failure as Error)).toBe(true);
    expect(isTerminalCellFailure(1, 3, new Error('provider 503'))).toBe(false);
  });
});
