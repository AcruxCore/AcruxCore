import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';
import { EvalRuleRepository } from '../../evaluations/online';

const app = createApp();

const iso = (d: Date): string => d.toISOString();

/** Canned OpenAI-shaped provider response for the mocked gateway fetch. */
const OPENAI_RESPONSE = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
};

async function ingest(agent: ReturnType<typeof request.agent>, traces: unknown[]): Promise<string[]> {
  const res = await agent.post('/api/v1/traces').send({ traces }).expect(200);
  return res.body.traceIds as string[];
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
    span_payloads, spans, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys, provider_connections,
    audit_log, prompt_aliases, prompt_versions, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/v1/traces/:id', () => {
  it('assembles the span tree with a nested tool child and per-span payload presence', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    // capturePayloads:true → payload rows written for spans that carry input/output.
    const [traceId] = await ingest(agent, [
      {
        name: 'support-agent-run',
        sessionId: 'chat-42',
        capturePayloads: true,
        spans: [
          {
            spanId: 's1', name: 'gpt-4o-mini', kind: 'llm', status: 'ok',
            startTime: iso(now), endTime: iso(new Date(now.getTime() + 900)),
            model: 'gpt-4o-mini', provider: 'openai',
            usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 }, costUsd: 0.0000234,
            input: { messages: [{ role: 'user', content: 'refunds?' }] },
            output: { content: 'here you go' },
          },
          {
            spanId: 's2', parentSpanId: 's1', name: 'search_docs', kind: 'tool', status: 'ok',
            startTime: iso(now), attributes: { query: 'refunds' },
            // no input/output → no payload row even though capture is on
          },
        ],
      },
    ]);

    const res = await agent.get(`/api/v1/traces/${traceId}`).expect(200);

    expect(res.body.trace.id).toBe(traceId);
    expect(res.body.trace.sessionId).toBe('chat-42');

    // One root (s1) with one nested child (s2).
    expect(res.body.spans).toHaveLength(1);
    const root = res.body.spans[0];
    expect(root.spanId).toBe('s1');
    expect(root.kind).toBe('llm');
    expect(root.model).toBe('gpt-4o-mini');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].spanId).toBe('s2');
    expect(root.children[0].parentSpanId).toBe('s1');
    expect(root.children[0].attributes.query).toBe('refunds');

    // Payload present on the captured llm span, absent on the tool span.
    expect(root.payload).toBeDefined();
    expect(root.payload.output.content).toBe('here you go');
    expect(root.children[0].payload).toBeUndefined();
  });

  it('omits payload entirely when capture is switched off for the request', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    const [traceId] = await ingest(agent, [
      {
        name: 'no-capture',
        capturePayloads: false,
        spans: [
          { spanId: 's1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now), input: { a: 1 }, output: { b: 2 } },
        ],
      },
    ]);
    const res = await agent.get(`/api/v1/traces/${traceId}`).expect(200);
    expect(res.body.spans[0].payload).toBeUndefined();
  });

  // The team default is capture-ON (phase-3-faq Q25): a trace whose inputs and
  // outputs are missing is not much of a trace, and the people most likely to
  // need them are the least likely to have found the setting. This case exists
  // so a silent flip back to off would fail rather than quietly stop recording.
  it('captures payloads when nothing asks it not to', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    const [traceId] = await ingest(agent, [
      {
        name: 'default-capture',
        spans: [
          { spanId: 's1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now), input: { a: 1 }, output: { b: 2 } },
        ],
      },
    ]);
    const res = await agent.get(`/api/v1/traces/${traceId}`).expect(200);
    expect(res.body.spans[0].payload).toBeDefined();
    expect(res.body.spans[0].payload.output).toEqual({ b: 2 });
  });

  it('links promptVersionId and gatewayRequestId on a gateway-minted llm span', async () => {
    const { agent } = await authedAgent(app);
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(OPENAI_RESPONSE), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    // Post-#14 (model registry): a completion resolves via a registered model,
    // so register `gpt-4o-mini` against the connection before calling.
    const conn = await agent.post('/api/v1/gateway/connections').send({ provider: 'openai', label: 't', apiKey: 'sk-test-000000000000AB12', config: {} }).expect(201);
    await agent.post('/api/v1/gateway/models').send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id }).expect(201);
    const p = await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201);
    const v1 = await agent.post(`/api/v1/prompts/${p.body.id}/versions`).send({ messages: [{ role: 'system', content: 'Hello {{ name }}' }] }).expect(201);
    await agent.post('/api/v1/gateway/chat/completions').send({ model: 'gpt-4o-mini', prompt: { name: 'greeting', alias: 'production', variables: { name: 'Al' } } }).expect(200);

    // The gateway call minted a single-span trace; find it via the list.
    const list = await agent.get('/api/v1/traces?limit=1').expect(200);
    const traceId = list.body.data[0].id;

    const res = await agent.get(`/api/v1/traces/${traceId}`).expect(200);
    const span = res.body.spans[0];
    expect(span.kind).toBe('llm');
    expect(span.promptVersionId).toBe(v1.body.id);
    expect(span.gatewayRequestId).not.toBeNull();
  });

  it('includes posted feedback newest-first, echoing spanRef', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    const [traceId] = await ingest(agent, [
      {
        name: 'feedback-run',
        spans: [
          { spanId: 's1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now) },
        ],
      },
    ]);

    await agent.post(`/api/v1/traces/${traceId}/feedback`).send({ rating: 1, comment: 'first' }).expect(201);
    await agent
      .post(`/api/v1/traces/${traceId}/feedback`)
      .send({ rating: -1, spanId: 's1', comment: 'second' })
      .expect(201);

    const res = await agent.get(`/api/v1/traces/${traceId}`).expect(200);

    // Existing fields are untouched.
    expect(res.body.trace.id).toBe(traceId);
    expect(res.body.spans).toHaveLength(1);

    expect(res.body.feedback).toHaveLength(2);
    // Newest-first: the second post (spanId: 's1') comes before the first.
    expect(res.body.feedback[0].comment).toBe('second');
    expect(res.body.feedback[0].spanId).toBe('s1');
    expect(res.body.feedback[1].comment).toBe('first');
    expect(res.body.feedback[1].spanId).toBeNull();
  });

  it('returns an empty feedback array when the trace has none', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    const [traceId] = await ingest(agent, [
      { name: 'no-feedback', spans: [{ spanId: 's1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now) }] },
    ]);
    const res = await agent.get(`/api/v1/traces/${traceId}`).expect(200);
    expect(res.body.feedback).toEqual([]);
  });

  it('includes online-eval rule scores with the scoring rule\'s name attached, newest-first', async () => {
    const { agent, teamId, userId } = await authedAgent(app);
    const now = new Date();
    const [traceId] = await ingest(agent, [
      { name: 'scored-run', spans: [{ spanId: 's1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now) }] },
    ]);

    const evalRuleRepo = new EvalRuleRepository();
    const rule = await evalRuleRepo.create(teamId, userId, {
      name: 'answers the question',
      criteria: 'the reply must answer the question asked',
      judgeModel: 'gpt-4o-mini',
      sampleRate: 1,
      dailyLimit: null,
      alertBelow: null,
      filter: {},
      enabled: true,
    });
    await evalRuleRepo.upsertScore({
      teamId,
      ruleId: rule.id,
      traceId,
      spanId: randomUUID(),
      score: 92,
      passed: true,
      reason: 'directly answers the question',
      judgeTraceId: randomUUID(),
      costUsd: 0.001,
    });

    const res = await agent.get(`/api/v1/traces/${traceId}`).expect(200);

    expect(res.body.evalScores).toHaveLength(1);
    expect(res.body.evalScores[0].ruleId).toBe(rule.id);
    expect(res.body.evalScores[0].ruleName).toBe('answers the question');
    expect(res.body.evalScores[0].score).toBe(92);
    expect(res.body.evalScores[0].passed).toBe(true);
    expect(res.body.evalScores[0].reason).toBe('directly answers the question');
    expect(res.body.evalScores[0].judgeTraceId).not.toBeNull();
  });

  it('returns an empty evalScores array when the trace has no rule scores', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    const [traceId] = await ingest(agent, [
      { name: 'unscored-run', spans: [{ spanId: 's1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now) }] },
    ]);
    const res = await agent.get(`/api/v1/traces/${traceId}`).expect(200);
    expect(res.body.evalScores).toEqual([]);
  });

  it('returns 404 for a trace not in the team', async () => {
    const { agent } = await authedAgent(app);
    await agent.get('/api/v1/traces/00000000-0000-0000-0000-000000000000').expect(404);
  });

  it('does not leak another team trace by id (404)', async () => {
    const { agent: a } = await authedAgent(app);
    const now = new Date();
    const [traceId] = await ingest(a, [
      { name: 'a-run', spans: [{ spanId: 'a1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now) }] },
    ]);
    const { agent: b } = await authedAgent(app);
    await b.get(`/api/v1/traces/${traceId}`).expect(404);
  });

  it('T8: trace detail exposes tags and metadata', async () => {
    const { agent } = await authedAgent(app);
    const [traceId] = await ingest(agent, [
      {
        tags: ['prod', 'nl'],
        metadata: { env: 'prod' },
        spans: [{ spanId: 's1', name: 'step', kind: 'llm', startTime: '2026-07-05T10:00:00Z' }],
      },
    ]);

    const res = await agent.get(`/api/v1/traces/${traceId}`).expect(200);
    expect(res.body.trace.tags.sort()).toEqual(['nl', 'prod']);
    expect(res.body.trace.metadata).toEqual({ env: 'prod' });
  });

  it('T10: trace detail exposes span-level tags and metadata set via the gateway x-span-* contract', async () => {
    const { agent } = await authedAgent(app);
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(OPENAI_RESPONSE), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const conn = await agent.post('/api/v1/gateway/connections').send({ provider: 'openai', label: 't', apiKey: 'sk-test-000000000000AB12', config: {} }).expect(201);
    await agent.post('/api/v1/gateway/models').send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id }).expect(201);

    await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-span-tags', 'flights,summarize')
      .set('x-span-metadata', JSON.stringify({ segment: 'flights' }))
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
      .expect(200);

    const list = await agent.get('/api/v1/traces?limit=1').expect(200);
    const traceId = list.body.data[0].id;

    const res = await agent.get(`/api/v1/traces/${traceId}`).expect(200);
    const span = res.body.spans[0];
    expect(span.tags.sort()).toEqual(['flights', 'summarize']);
    expect(span.metadata).toEqual({ segment: 'flights' });
  });
});
