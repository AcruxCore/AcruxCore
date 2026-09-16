import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent, registerTestModel } from '../../test-utils';

/**
 * What a malformed `trace` or `span` object does to a gateway call (issue #511).
 *
 * Both were read off the raw body with a bare cast, so whatever the caller sent
 * was passed inward wearing a type it might not have. A `tags` that was a string
 * rather than an array reached Prisma as a string and threw inside the trace
 * write — which is best-effort, so the completion was answered and billed with
 * its trace silently missing and nothing said.
 *
 * The rule now: a bad field is dropped, never fatal, and the caller is told.
 * Refusing a paid completion over a tracing detail would be worse than the
 * problem; dropping it in silence is what made this invisible.
 *
 * Every case asserts against a trace row in the database rather than the
 * response body, because the response was always 200 — the whole failure was
 * that the row did not appear.
 */
const app = createApp();

const CANNED_OPENAI = {
  id: 'chatcmpl-ctx',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
};

function mockFetch(): void {
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => CANNED_OPENAI,
    text: async () => JSON.stringify(CANNED_OPENAI),
    headers: new Headers(),
  } as unknown as Response);
}

async function truncateTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    span_payloads, spans, traces, team_trace_settings,
    gateway_requests, gateway_cache, gateway_model_fallbacks, gateway_models, provider_connections,
    audit_log, api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
}

beforeEach(truncateTables);
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
});

describe('a malformed trace or span object on POST /gateway/chat/completions', () => {
  /** Signs up, registers a model, and returns an agent plus the model's public name. */
  async function arrange() {
    const ctx = await authedAgent(app);
    const model = await registerTestModel(ctx.agent);
    mockFetch();
    return { ...ctx, model };
  }

  it('records the trace when the object is well formed — the control for every case below', async () => {
    const { agent, teamId, model } = await arrange();

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        trace: { name: 'control', tags: ['prod', 'eu'], metadata: { run: 1 } },
      })
      .expect(200);

    expect(res.headers['x-gateway-trace-id']).toBeTruthy();
    expect(res.headers['x-gateway-context-ignored']).toBeUndefined();

    const trace = await prisma.trace.findFirst({ where: { teamId } });
    expect(trace?.name).toBe('control');
    expect(trace?.tags).toEqual(['prod', 'eu']);
    expect(trace?.metadata).toEqual({ run: 1 });
  });

  it('still records the trace when `tags` is a string, and says the field was ignored', async () => {
    const { agent, teamId, model } = await arrange();

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        trace: { name: 'bad tags', tags: 'prod' },
      })
      .expect(200);

    expect(res.headers['x-gateway-context-ignored']).toBe('trace.tags');
    expect(res.headers['x-gateway-trace-id']).toBeTruthy();

    // The name survived: one bad field costs the caller that field, not the object.
    const trace = await prisma.trace.findFirst({ where: { teamId } });
    expect(trace?.name).toBe('bad tags');
    expect(trace?.tags).toEqual([]);
  });

  it('keeps the good fields and names every bad one', async () => {
    const { agent, teamId, model } = await arrange();

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        trace: { name: 'mixed', tags: [1, 2], metadata: 'nope', sessionId: 'sess-1' },
      })
      .expect(200);

    const ignored = (res.headers['x-gateway-context-ignored'] as string).split(',').sort();
    expect(ignored).toEqual(['trace.metadata', 'trace.tags']);

    const trace = await prisma.trace.findFirst({ where: { teamId } });
    expect(trace?.name).toBe('mixed');
    expect(trace?.sessionId).toBe('sess-1');
    // Not the JSON string "nope", which is what the cast used to write here.
    expect(trace?.metadata).toEqual({});
  });

  it('records the trace when `span.name` is an object rather than a string', async () => {
    const { agent, teamId, model } = await arrange();

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model, messages: [{ role: 'user', content: 'hi' }], span: { name: { a: 1 } } })
      .expect(200);

    expect(res.headers['x-gateway-context-ignored']).toBe('span.name');
    const trace = await prisma.trace.findFirst({ where: { teamId } });
    expect(trace).not.toBeNull();
  });

  it('records the trace when `traceId` is a number rather than a uuid', async () => {
    const { agent, teamId, model } = await arrange();

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model, messages: [{ role: 'user', content: 'hi' }], trace: { traceId: 123 } })
      .expect(200);

    expect(res.headers['x-gateway-context-ignored']).toBe('trace.traceId');
    // A fresh trace, rather than a failed lookup for a trace whose id is not a uuid.
    const trace = await prisma.trace.findFirst({ where: { teamId } });
    expect(trace).not.toBeNull();
  });

  it('drops a `trace` that is not an object at all, under its own name', async () => {
    const { agent, teamId, model } = await arrange();

    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model, messages: [{ role: 'user', content: 'hi' }], trace: 'nope' })
      .expect(200);

    expect(res.headers['x-gateway-context-ignored']).toBe('trace');
    expect(await prisma.trace.findFirst({ where: { teamId } })).not.toBeNull();
  });

  it('ignores an `x-trace-metadata` header that is valid JSON of the wrong shape', async () => {
    const { agent, teamId, model } = await arrange();

    // `JSON.parse` succeeds on both of these, so a try/catch alone never saw them.
    const res = await agent
      .post('/api/v1/gateway/chat/completions')
      .set('x-trace-metadata', '[1,2]')
      .send({ model, messages: [{ role: 'user', content: 'hi' }] })
      .expect(200);

    expect(res.headers['x-gateway-context-ignored']).toBe('x-trace-metadata');
    const trace = await prisma.trace.findFirst({ where: { teamId } });
    expect(trace?.metadata).toEqual({});
  });
});
