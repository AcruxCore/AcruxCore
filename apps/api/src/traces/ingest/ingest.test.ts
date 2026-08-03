import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

/** Canned OpenAI response used only by the gateway-append test's mocked fetch. */
const OPENAI_RESPONSE = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

interface Ctx {
  agent: ReturnType<typeof request.agent>;
  apiKey: string;
  teamId: string;
  userId: string;
}

/** Signs up an owner; returns a session agent + personal API key + teamId. */
async function signup(): Promise<Ctx> {
  const { agent, teamId, userId } = await authedAgent(app);
  const keyRes = await agent.post('/api/v1/api-keys').send({ name: 't2' }).expect(201);
  return {
    agent,
    apiKey: keyRes.body.key as string,
    teamId,
    userId,
  };
}

/** Two nested spans + a custom span (llm → tool child → chain). */
function threeSpanTrace(): unknown {
  return {
    name: 'support-agent-run',
    spans: [
      {
        spanId: 's1', name: 'gpt-4o-mini', kind: 'llm',
        startTime: '2026-07-04T10:00:00.000Z', endTime: '2026-07-04T10:00:01.000Z',
        model: 'gpt-4o-mini', provider: 'openai',
        usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
        costUsd: 0.0000234, status: 'ok',
        input: { messages: [{ role: 'user', content: 'hi' }] }, output: { content: 'hello' },
      },
      {
        spanId: 's2', parentSpanId: 's1', name: 'search_docs', kind: 'tool',
        startTime: '2026-07-04T10:00:00.200Z', endTime: '2026-07-04T10:00:00.500Z',
        status: 'ok', attributes: { query: 'refunds' },
      },
      {
        spanId: 's3', parentSpanId: 's1', name: 'assemble-answer', kind: 'chain',
        startTime: '2026-07-04T10:00:00.600Z', endTime: '2026-07-04T10:00:00.900Z', status: 'ok',
      },
    ],
  };
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

describe('POST /api/v1/traces — ingestion', () => {
  it('ingests a nested trace and computes correct parent linkage + rollups', async () => {
    const { agent, teamId } = await signup();

    const res = await agent.post('/api/v1/traces').send({ traces: [threeSpanTrace()] }).expect(200);

    expect(res.body.accepted).toBe(3);
    expect(res.body.traceIds).toHaveLength(1);
    const traceId = res.body.traceIds[0] as string;

    const spans = await prisma.span.findMany({ where: { traceId }, orderBy: { spanRef: 'asc' } });
    expect(spans).toHaveLength(3);
    const byRef = Object.fromEntries(spans.map((s) => [s.spanRef, s]));
    expect(byRef.s1.parentSpanRef).toBeNull();
    expect(byRef.s2.parentSpanRef).toBe('s1');
    expect(byRef.s3.parentSpanRef).toBe('s1');
    expect(byRef.s1.kind).toBe('llm');
    expect(byRef.s2.kind).toBe('tool');
    expect(byRef.s1.latencyMs).toBe(1000);

    const trace = await prisma.trace.findUnique({ where: { id: traceId } });
    expect(trace?.teamId).toBe(teamId);
    expect(trace?.spanCount).toBe(3);
    expect(trace?.totalTokens).toBe(160);
    expect(Number(trace?.totalCostUsd)).toBeCloseTo(0.0000234, 9);
  });

  it('appends to a trace minted by a real gateway completion (one trace total)', async () => {
    const { agent, teamId } = await signup();

    // Arrange: a real gateway completion mints a single-span trace (T1 hook).
    // Post model-registry split (commit #14) a completion needs BOTH a connection
    // (credential) AND a registered model bound to it — mirror completions.test.ts.
    const conn = await agent
      .post('/api/v1/gateway/connections')
      .send({ provider: 'openai', label: 'openai test', apiKey: 'sk-test-abcdAB12', config: {} })
      .expect(201);
    await agent
      .post('/api/v1/gateway/models')
      .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id })
      .expect(201);

    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(OPENAI_RESPONSE), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await agent
      .post('/api/v1/gateway/chat/completions')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
      .expect(200);

    const minted = await prisma.trace.findFirst({ where: { teamId } });
    expect(minted).not.toBeNull();
    const traceId = minted!.id;
    const gatewaySpans = await prisma.span.findMany({ where: { traceId } });
    expect(gatewaySpans).toHaveLength(1);
    const gatewaySpanRef = gatewaySpans[0].spanRef;

    // Act: report an SDK tool span under that same traceId, parented to the gateway span.
    const res = await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            traceId,
            spans: [
              {
                spanId: 'tool-1', parentSpanId: gatewaySpanRef, name: 'search_docs', kind: 'tool',
                startTime: '2026-07-04T10:00:02.000Z', endTime: '2026-07-04T10:00:02.100Z', status: 'ok',
              },
            ],
          },
        ],
      })
      .expect(200);

    expect(res.body.traceIds).toEqual([traceId]);

    // Assert: still exactly one trace for the team, now with two spans.
    const allTraces = await prisma.trace.findMany({ where: { teamId } });
    expect(allTraces).toHaveLength(1);
    const allSpans = await prisma.span.findMany({ where: { traceId } });
    expect(allSpans).toHaveLength(2);
    const updated = await prisma.trace.findUnique({ where: { id: traceId } });
    expect(updated?.spanCount).toBe(2);
  });

  it('stores payloads when capture is on (default)', async () => {
    const { agent } = await signup();
    const res = await agent.post('/api/v1/traces').send({ traces: [threeSpanTrace()] }).expect(200);
    const traceId = res.body.traceIds[0] as string;

    const s1 = await prisma.span.findFirst({ where: { traceId, spanRef: 's1' } });
    const payload = await prisma.spanPayload.findUnique({ where: { spanId: s1!.id } });
    expect(payload).not.toBeNull();
    expect(payload?.output).toEqual({ content: 'hello' });

    // s2/s3 carry no input/output → no payload rows for them.
    const all = await prisma.spanPayload.findMany({});
    expect(all).toHaveLength(1);
  });

  it('does not store payloads when the team setting is off', async () => {
    const { agent } = await signup();
    await agent.put('/api/v1/traces/settings').send({ capturePayloads: false }).expect(200);

    const res = await agent.post('/api/v1/traces').send({ traces: [threeSpanTrace()] }).expect(200);

    const payloads = await prisma.spanPayload.findMany({});
    expect(payloads).toHaveLength(0);
    void res;
  });

  it('stores payloads on a per-request capturePayloads:true override while the team default is off', async () => {
    const { agent } = await signup();
    await agent.put('/api/v1/traces/settings').send({ capturePayloads: false }).expect(200);

    const trace = threeSpanTrace() as { capturePayloads?: boolean };
    trace.capturePayloads = true;

    const res = await agent.post('/api/v1/traces').send({ traces: [trace] }).expect(200);
    const traceId = res.body.traceIds[0] as string;
    const s1 = await prisma.span.findFirst({ where: { traceId, spanRef: 's1' } });
    const payload = await prisma.spanPayload.findUnique({ where: { spanId: s1!.id } });
    expect(payload).not.toBeNull();
  });

  it('skips payloads on a per-request capturePayloads:false override while the team default is on', async () => {
    const { agent } = await signup();

    const trace = threeSpanTrace() as { capturePayloads?: boolean };
    trace.capturePayloads = false;

    const res = await agent.post('/api/v1/traces').send({ traces: [trace] }).expect(200);
    const traceId = res.body.traceIds[0] as string;
    const s1 = await prisma.span.findFirst({ where: { traceId, spanRef: 's1' } });
    const payload = await prisma.spanPayload.findUnique({ where: { spanId: s1!.id } });
    expect(payload).toBeNull();
  });

  it('rejects a duplicate spanId within a trace with 400 VALIDATION_ERROR', async () => {
    const { agent } = await signup();
    const res = await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            name: 'dup',
            spans: [
              { spanId: 'x', name: 'a', startTime: '2026-07-04T10:00:00.000Z' },
              { spanId: 'x', name: 'b', startTime: '2026-07-04T10:00:00.000Z' },
            ],
          },
        ],
      })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a dangling parentSpanId with 400 INVALID_SPAN_PARENT', async () => {
    const { agent } = await signup();
    const res = await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            name: 'orphan',
            spans: [
              { spanId: 's1', parentSpanId: 'ghost', name: 'a', startTime: '2026-07-04T10:00:00.000Z' },
            ],
          },
        ],
      })
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_SPAN_PARENT');
  });

  it('rejects a batch of more than 200 spans with 413 PAYLOAD_TOO_LARGE', async () => {
    const { agent } = await signup();
    const spans = Array.from({ length: 201 }, (_, i) => ({
      spanId: `s${i}`, name: 'x', startTime: '2026-07-04T10:00:00.000Z',
    }));
    const res = await agent.post('/api/v1/traces').send({ traces: [{ name: 'big', spans }] }).expect(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('accepts exactly 200 spans in one trace', async () => {
    const { agent } = await signup();
    const spans = Array.from({ length: 200 }, (_, i) => ({
      spanId: `s${i}`, name: 'x', startTime: '2026-07-04T10:00:00.000Z',
    }));
    const res = await agent.post('/api/v1/traces').send({ traces: [{ name: 'cap', spans }] }).expect(200);
    expect(res.body.accepted).toBe(200);
  });

  it('rejects a ≤200-span batch that is also malformed with 400 (Zod) before the cap check', async () => {
    const { agent } = await signup();
    // 5 spans total (well under the 200 cap) but one has a duplicate spanId — proves
    // Zod validation (400) runs BEFORE the service's cap/parent logic sees the batch.
    const res = await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            name: 'small-but-malformed',
            spans: [
              { spanId: 'a', name: 'x', startTime: '2026-07-04T10:00:00.000Z' },
              { spanId: 'a', name: 'y', startTime: '2026-07-04T10:00:00.000Z' },
              { spanId: 'b', name: 'z', startTime: '2026-07-04T10:00:00.000Z' },
              { spanId: 'c', name: 'w', startTime: '2026-07-04T10:00:00.000Z' },
              { spanId: 'd', name: 'v', startTime: '2026-07-04T10:00:00.000Z' },
            ],
          },
        ],
      })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a >200-span batch containing a malformed span with 400, not 413 (proves Zod runs before the cap check)', async () => {
    const { agent } = await signup();
    // 201 spans (over the cap) where ONE is malformed (missing required `name`).
    // If the cap check ran first, this would 413 like the "well-formed 201" test
    // above; getting 400 instead proves Zod validation is checked before the
    // service ever sees — and could reject on — the span count.
    const spans = Array.from({ length: 201 }, (_, i) =>
      i === 100
        ? { spanId: `s${i}`, startTime: '2026-07-04T10:00:00.000Z' } // missing `name`
        : { spanId: `s${i}`, name: 'x', startTime: '2026-07-04T10:00:00.000Z' },
    );
    const res = await agent.post('/api/v1/traces').send({ traces: [{ name: 'big-and-malformed', spans }] }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it("returns 404 when the traceId belongs to another team (no cross-tenant append)", async () => {
    const teamA = await signup();
    const teamB = await signup();

    const created = await teamA.agent.post('/api/v1/traces').send({ traces: [threeSpanTrace()] }).expect(200);
    const foreignTraceId = created.body.traceIds[0] as string;

    const res = await teamB.agent
      .post('/api/v1/traces')
      .send({
        traces: [
          { traceId: foreignTraceId, spans: [{ spanId: 'z', name: 'x', startTime: '2026-07-04T10:00:00.000Z' }] },
        ],
      })
      .expect(404);

    // No mention of team A's trace name/content leaks through the error body.
    expect(JSON.stringify(res.body)).not.toContain('support-agent-run');

    // Team A's trace is untouched (still 3 spans, span_count unchanged).
    const spans = await prisma.span.findMany({ where: { traceId: foreignTraceId } });
    expect(spans).toHaveLength(3);
    const trace = await prisma.trace.findUnique({ where: { id: foreignTraceId } });
    expect(trace?.spanCount).toBe(3);
  });

  it('a caller-supplied traceId (UUID) becomes the row PK when no trace exists yet', async () => {
    const { agent } = await signup();
    const suppliedId = '11111111-1111-4111-8111-111111111111';
    const res = await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          { traceId: suppliedId, spans: [{ spanId: 's1', name: 'x', startTime: '2026-07-04T10:00:00.000Z' }] },
        ],
      })
      .expect(200);
    expect(res.body.traceIds).toEqual([suppliedId]);
    const trace = await prisma.trace.findUnique({ where: { id: suppliedId } });
    expect(trace).not.toBeNull();
  });

  it('appends to an existing SDK-created trace across two requests (span_count grows, no new trace)', async () => {
    const { agent, teamId } = await signup();
    const first = await agent
      .post('/api/v1/traces')
      .send({ traces: [{ name: 'multi-request', spans: [{ spanId: 's1', name: 'x', startTime: '2026-07-04T10:00:00.000Z' }] }] })
      .expect(200);
    const traceId = first.body.traceIds[0] as string;

    const second = await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          { traceId, spans: [{ spanId: 's2', parentSpanId: 's1', name: 'y', startTime: '2026-07-04T10:00:01.000Z' }] },
        ],
      })
      .expect(200);
    expect(second.body.traceIds).toEqual([traceId]);

    const traces = await prisma.trace.findMany({ where: { teamId } });
    expect(traces).toHaveLength(1);
    const trace = await prisma.trace.findUnique({ where: { id: traceId } });
    expect(trace?.spanCount).toBe(2);

    // s2's parent (s1) only exists in the PRIOR stored batch — resolved via listSpanRefs.
    const s2 = await prisma.span.findFirst({ where: { traceId, spanRef: 's2' } });
    expect(s2?.parentSpanRef).toBe('s1');
  });

  it('T8: stores tags/metadata on a new trace; no name → ISO timestamp fallback', async () => {
    const { agent, teamId } = await signup();
    const res = await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            tags: ['prod', 'nl'],
            metadata: { env: 'prod' },
            spans: [{ spanId: 's1', name: 'step', startTime: '2026-07-05T10:00:00Z' }],
          },
        ],
      })
      .expect(200);

    const trace = await prisma.trace.findFirst({ where: { id: res.body.traceIds[0], teamId } });
    expect(trace!.tags.sort()).toEqual(['nl', 'prod']);
    expect(trace!.metadata).toEqual({ env: 'prod' });
    expect(trace!.name).not.toBeNull();
    expect(() => new Date(trace!.name!).toISOString()).not.toThrow();
  });

  it('T8: appending to an existing traceId merges tags/metadata rather than overwriting', async () => {
    const { agent, teamId } = await signup();
    const first = await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            tags: ['a'],
            metadata: { k: 'v1', j: '1' },
            spans: [{ spanId: 's1', name: 'step', startTime: '2026-07-05T10:00:00Z' }],
          },
        ],
      })
      .expect(200);
    const traceId = first.body.traceIds[0];

    await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            traceId,
            tags: ['b'],
            metadata: { k: 'v2' },
            spans: [{ spanId: 's2', name: 'step-2', startTime: '2026-07-05T10:00:01Z' }],
          },
        ],
      })
      .expect(200);

    const trace = await prisma.trace.findFirst({ where: { id: traceId, teamId } });
    expect(trace!.tags.sort()).toEqual(['a', 'b']);
    expect(trace!.metadata).toEqual({ k: 'v2', j: '1' });
  });

  it('accepts a forward-reference parent (child appears before its parent in wire order)', async () => {
    const { agent } = await signup();
    const res = await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            name: 'forward-ref',
            spans: [
              { spanId: 'child', parentSpanId: 'parent', name: 'c', startTime: '2026-07-04T10:00:00.000Z' },
              { spanId: 'parent', name: 'p', startTime: '2026-07-04T10:00:00.000Z' },
            ],
          },
        ],
      })
      .expect(200);
    expect(res.body.accepted).toBe(2);
  });

  it('rejects a parent that exists only in a DIFFERENT trace of the same multi-trace request (per-trace parent scope)', async () => {
    const { agent } = await signup();
    const res = await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          { name: 'trace-1', spans: [{ spanId: 'shared-ref', name: 'a', startTime: '2026-07-04T10:00:00.000Z' }] },
          {
            name: 'trace-2',
            spans: [
              { spanId: 'x', parentSpanId: 'shared-ref', name: 'b', startTime: '2026-07-04T10:00:00.000Z' },
            ],
          },
        ],
      })
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_SPAN_PARENT');
  });

  it('rolls back the trace row on a pre-insert parent-validation failure (no spans ever inserted)', async () => {
    const { agent } = await signup();
    // NOTE: this only proves rollback of the newly-created TRACE row — parent
    // validation runs before any appendSpan call, so s1/s2 are never actually
    // inserted here. See the next test for a genuine mid-APPEND (post-insert)
    // failure, which is what invariant #7 is really asking for.
    const res = await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            name: 'mid-batch-failure',
            spans: [
              { spanId: 's1', name: 'ok-1', startTime: '2026-07-04T10:00:00.000Z' },
              { spanId: 's2', parentSpanId: 's1', name: 'ok-2', startTime: '2026-07-04T10:00:01.000Z' },
              { spanId: 's3', parentSpanId: 'nonexistent', name: 'bad', startTime: '2026-07-04T10:00:02.000Z' },
            ],
          },
        ],
      })
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_SPAN_PARENT');

    const traces = await prisma.trace.findMany({});
    expect(traces).toHaveLength(0);
    const spans = await prisma.span.findMany({});
    expect(spans).toHaveLength(0);
  });

  it('rolls back a genuinely mid-APPEND failure: a spanId already stored under the trace from a prior request', async () => {
    const { agent } = await signup();

    // First request commits one span (s1) under a new trace.
    const first = await agent
      .post('/api/v1/traces')
      .send({ traces: [{ name: 'mid-append', spans: [{ spanId: 's1', name: 'ok-1', startTime: '2026-07-04T10:00:00.000Z' }] }] })
      .expect(200);
    const traceId = first.body.traceIds[0] as string;

    // Second request: s2 is new and valid and inserts FIRST; then s1 re-uses an
    // already-stored spanId, which passes Zod (unique only *within this batch*)
    // and passes the service's parent check (it isn't a parentSpanId issue), so
    // it reaches SpansRepository.appendSpan and trips the DB's
    // (trace_id, span_ref) unique constraint — a true post-insert, mid-loop failure.
    const res = await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            traceId,
            spans: [
              { spanId: 's2', name: 'new-but-will-be-rolled-back', startTime: '2026-07-04T10:00:01.000Z' },
              { spanId: 's1', name: 'duplicate-of-prior-request', startTime: '2026-07-04T10:00:02.000Z' },
            ],
          },
        ],
      });

    // KNOWN GAP (Task 3 IngestService, not fixed here — out of Task 4's file
    // scope): unlike dangling parents (validated up front against listSpanRefs
    // and mapped to a clean 400 INVALID_SPAN_PARENT), a spanId collision against
    // an ALREADY-STORED span from a prior request is not pre-validated. It falls
    // through to a raw Prisma P2002 and the global error middleware's generic
    // 500 INTERNAL_ERROR. This assertion pins today's actual behavior; if this
    // ever starts passing 400/409 instead, the service added the missing
    // pre-flight check and this comment (and the finding in the T4 report) is stale.
    expect(res.status).toBe(500);

    // The load-bearing assertion: even though the failure is a raw DB error and
    // not a validated AppError, the $transaction still rolled back — s2 (which
    // inserted successfully before s1 blew up) does NOT persist.
    const spans = await prisma.span.findMany({ where: { traceId } });
    expect(spans).toHaveLength(1);
    expect(spans[0].spanRef).toBe('s1');
    const trace = await prisma.trace.findUnique({ where: { id: traceId } });
    expect(trace?.spanCount).toBe(1);
  });

  it('commits trace 1 of a multi-trace batch when trace 2 fails (per-trace tx, not per-batch)', async () => {
    const { agent } = await signup();
    const res = await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          { name: 'valid-trace', spans: [{ spanId: 's1', name: 'ok', startTime: '2026-07-04T10:00:00.000Z' }] },
          {
            name: 'failing-trace',
            spans: [{ spanId: 's1', parentSpanId: 'ghost', name: 'bad', startTime: '2026-07-04T10:00:00.000Z' }],
          },
        ],
      })
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_SPAN_PARENT');
    expect(res.body.traceIds).toBeUndefined();

    // Trace 1 committed despite trace 2's failure — documents the non-atomic-across-batch behavior.
    const traces = await prisma.trace.findMany({});
    expect(traces).toHaveLength(1);
    expect(traces[0].name).toBe('valid-trace');
    const spans = await prisma.span.findMany({ where: { traceId: traces[0].id } });
    expect(spans).toHaveLength(1);
  });

  it('writes no payload row for a capture-on span with neither input nor output', async () => {
    const { agent } = await signup();
    const res = await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            name: 'no-io',
            capturePayloads: true,
            spans: [{ spanId: 's1', name: 'bare', startTime: '2026-07-04T10:00:00.000Z' }],
          },
        ],
      })
      .expect(200);
    const traceId = res.body.traceIds[0] as string;
    const s1 = await prisma.span.findFirst({ where: { traceId, spanRef: 's1' } });
    // Current contract (ingest.service.ts): a payload row is written only when
    // input !== undefined || output !== undefined. Neither is present here, so
    // no span_payloads row is written even though capture resolved on.
    const payload = await prisma.spanPayload.findUnique({ where: { spanId: s1!.id } });
    expect(payload).toBeNull();
  });

  it('rounds latencyMs and leaves endedAt null when no endTime is supplied', async () => {
    const { agent } = await signup();
    const res = await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            name: 'latency-and-open-span',
            spans: [
              {
                spanId: 's1', name: 'rounds', startTime: '2026-07-04T10:00:00.100Z',
                endTime: '2026-07-04T10:00:00.545Z',
              },
              { spanId: 's2', name: 'open', startTime: '2026-07-04T10:00:00.000Z' },
            ],
          },
        ],
      })
      .expect(200);
    const traceId = res.body.traceIds[0] as string;

    const s1 = await prisma.span.findFirst({ where: { traceId, spanRef: 's1' } });
    expect(s1?.latencyMs).toBe(445); // exact ms diff (Math.round is a defensive no-op on integer ms)

    const s2 = await prisma.span.findFirst({ where: { traceId, spanRef: 's2' } });
    expect(s2?.endedAt).toBeNull();
    expect(s2?.latencyMs).toBeNull();
  });

  it('accepts ingestion authenticated with a virtual key', async () => {
    const { agent, teamId } = await signup();
    const keyRes = await agent.post('/api/v1/gateway/keys').send({ name: 'vk' }).expect(201);
    const virtualKey = keyRes.body.key as string; // plaintext agh_sk_… returned once
    expect(virtualKey.startsWith('agh_sk_')).toBe(true);

    const res = await request(app)
      .post('/api/v1/traces')
      .set('Authorization', `Bearer ${virtualKey}`)
      .send({ traces: [threeSpanTrace()] })
      .expect(200);

    expect(res.body.accepted).toBe(3);
    const traces = await prisma.trace.findMany({ where: { teamId } });
    expect(traces).toHaveLength(1);
  });

  it('accepts ingestion from a viewer-role member (no requireRole gate)', async () => {
    const { agent, teamId, userId } = await signup();

    // Downgrade the owner to viewer in their own team via DB (mirrors completions.test.ts).
    await prisma.teamMember.update({
      where: { userId_teamId: { userId, teamId } },
      data: { role: 'viewer' },
    });

    const res = await agent.post('/api/v1/traces').send({ traces: [threeSpanTrace()] }).expect(200);
    expect(res.body.accepted).toBe(3);
  });

  it('rejects an unauthenticated request with 401', async () => {
    await request(app).post('/api/v1/traces').send({ traces: [threeSpanTrace()] }).expect(401);
  });

  it('rejects a request with an invalid bearer token with 401', async () => {
    await request(app)
      .post('/api/v1/traces')
      .set('Authorization', 'Bearer garbage-not-a-real-token')
      .send({ traces: [threeSpanTrace()] })
      .expect(401);
  });

  it('stores span variables when capture is on and exposes them in trace detail', async () => {
    const { agent } = await signup();

    const res = await agent
      .post('/api/v1/traces')
      .send({
        traces: [
          {
            capturePayloads: true,
            spans: [
              {
                spanId: 'span-1',
                name: 'llm',
                kind: 'llm',
                startTime: '2026-07-07T00:00:00.000Z',
                input: [{ role: 'user', content: 'Say hi to Al' }],
                output: { text: 'Hi Al' },
                variables: { name: 'Al' },
              },
            ],
          },
        ],
      })
      .expect(200);

    const traceId = res.body.traceIds[0] as string;
    const stored = await prisma.spanPayload.findFirst({ where: {} });
    expect(stored!.variables).toEqual({ name: 'Al' });

    const detail = await agent.get(`/api/v1/traces/${traceId}`).expect(200);
    expect(detail.body.spans[0].payload.variables).toEqual({ name: 'Al' });
  });
});
