import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';
import { getOnlineEvalQueue } from '../../evaluations/online/online-eval.queue';
import { enqueueOnlineEval } from '../../evaluations/online/enqueue-online-eval';

const app = createApp();

const CANNED_OPENAI = {
  id: 'chatcmpl-int',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
};

function mockFetchOnce(body: unknown): void {
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

async function createConnection(agent: ReturnType<typeof request.agent>): Promise<string> {
  const res = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
    .expect(201);
  return res.body.id;
}
async function registerModel(agent: ReturnType<typeof request.agent>, credentialId: string): Promise<void> {
  await agent.post('/api/v1/gateway/models').send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId }).expect(201);
}

async function truncateTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    span_payloads, spans, trace_feedback, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys,
    gateway_model_fallbacks, gateway_models, provider_connections,
    prompt_aliases, prompt_versions, prompts,
    audit_log, api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
}

beforeEach(async () => {
  await truncateTables();
  await getOnlineEvalQueue().drain(true);
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
  await getOnlineEvalQueue().close();
});

describe('online-eval enqueue trigger', () => {
  it('a gateway llm completion enqueues exactly one eval-online job', async () => {
    const { agent } = await authedAgent(app);
    const credId = await createConnection(agent);
    await registerModel(agent, credId);
    mockFetchOnce(CANNED_OPENAI);

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
      .expect(200);

    // Fire-and-forget: give the post-commit call a tick to run.
    await new Promise((r) => setTimeout(r, 50));
    const counts = await getOnlineEvalQueue().getJobCounts('waiting');
    expect(counts.waiting).toBe(1);
  });

  it('SDK-reported tool spans enqueue nothing', async () => {
    const { agent } = await authedAgent(app);
    await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            spans: [{ spanId: 'span-1', name: 'search', kind: 'tool', startTime: new Date().toISOString() }],
          },
        ],
      })
      .expect(200);

    await new Promise((r) => setTimeout(r, 50));
    const counts = await getOnlineEvalQueue().getJobCounts('waiting');
    expect(counts.waiting).toBe(0);
  });

  it('a rejected enqueue (e.g. a transient Redis blip) never throws or surfaces as an unhandled rejection', async () => {
    const queue = getOnlineEvalQueue();
    const addSpy = jest.spyOn(queue, 'add').mockRejectedValueOnce(new Error('redis blip'));
    const onUnhandledRejection = jest.fn();
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      expect(() =>
        enqueueOnlineEval({ teamId: 'team-1', traceId: 'trace-1', spanId: 'span-1', spanKind: 'llm' }),
      ).not.toThrow();

      // Give the rejected promise's microtask a tick to (mis)fire.
      await new Promise((r) => setTimeout(r, 50));
      expect(onUnhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      addSpy.mockRestore();
    }
  });
});
