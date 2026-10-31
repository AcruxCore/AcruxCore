// apps/api/src/traces/ingest/otlp/otlp.test.ts
import path from 'path';
import protobuf from 'protobufjs';
import request from 'supertest';
import zlib from 'zlib';
import { createApp } from '../../../../app';
import prisma from '../../../shared/db/client';
import { authedAgent } from '../../../test-utils';

const app = createApp();
const PROTO_ROOT = path.join(__dirname, 'proto');

async function encodeRequest(payload: Record<string, unknown>): Promise<Buffer> {
  // Vendored .proto files cross-reference each other with paths relative to
  // PROTO_ROOT (e.g. `import "opentelemetry/proto/trace/v1/trace.proto"`), so a
  // plain `protobuf.load()` resolves the import relative to the *importing*
  // file's directory instead and 404s. Mirror `otlp-decoder.ts`'s custom
  // `resolvePath` so this test's own encoder can actually load the schema.
  const root = new protobuf.Root();
  root.resolvePath = (origin: string, target: string) => {
    if (target.startsWith('opentelemetry/proto/')) {
      return path.join(PROTO_ROOT, target);
    }
    return path.resolve(path.dirname(origin), target);
  };
  await protobuf.load(path.join(PROTO_ROOT, 'opentelemetry/proto/collector/trace/v1/trace_service.proto'), root);
  const Type = root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest');
  const message = Type.create(payload);
  return Buffer.from(Type.encode(message).finish());
}

function crewAiPayload(traceIdHex: string, spanIdHex: string) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'crewai-trip-planner' } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: Buffer.from(traceIdHex, 'hex'),
                spanId: Buffer.from(spanIdHex, 'hex'),
                name: 'CrewAgentExecutor.invoke',
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000000500000000',
                attributes: [
                  { key: 'openinference.span.kind', value: { stringValue: 'AGENT' } },
                  { key: 'input.value', value: { stringValue: 'Plan a trip to Rome' } },
                  { key: 'output.value', value: { stringValue: 'Here is your itinerary...' } },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Builds a one-span export whose ids/parent/timing the caller controls. */
function spanPayload(opts: {
  traceIdHex: string;
  spanIdHex: string;
  parentSpanIdHex?: string;
  name: string;
  startNano: string;
}) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: Buffer.from(opts.traceIdHex, 'hex'),
                spanId: Buffer.from(opts.spanIdHex, 'hex'),
                ...(opts.parentSpanIdHex
                  ? { parentSpanId: Buffer.from(opts.parentSpanIdHex, 'hex') }
                  : {}),
                name: opts.name,
                startTimeUnixNano: opts.startNano,
                attributes: [{ key: 'openinference.span.kind', value: { stringValue: 'AGENT' } }],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** OTel hex trace id → the dashed UUID the trace is stored under. */
function toUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
    span_payloads, spans, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys, provider_connections,
    audit_log, prompt_aliases, prompt_versions, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/v1/traces/otlp', () => {
  it('ingests a real OpenInference-shaped protobuf export from a CrewAI-style agent', async () => {
    const { agent, teamId } = await authedAgent(app);
    const traceIdHex = 'a'.repeat(32);
    const body = await encodeRequest(crewAiPayload(traceIdHex, 'b'.repeat(16)));

    await agent
      .post('/api/v1/traces/otlp')
      .set('Content-Type', 'application/x-protobuf')
      .send(body)
      .expect(200);

    const expectedTraceId = `${traceIdHex.slice(0, 8)}-${traceIdHex.slice(8, 12)}-${traceIdHex.slice(12, 16)}-${traceIdHex.slice(16, 20)}-${traceIdHex.slice(20, 32)}`;
    const trace = await prisma.trace.findUnique({ where: { id: expectedTraceId } });
    expect(trace?.teamId).toBe(teamId);
    const spans = await prisma.span.findMany({ where: { traceId: expectedTraceId } });
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('agent');
    expect(spans[0].spanRef).toBe('b'.repeat(16));
  });

  it('accepts a gzip-compressed protobuf body (the OTel exporter default)', async () => {
    const { agent } = await authedAgent(app);
    const body = await encodeRequest(crewAiPayload('c'.repeat(32), 'd'.repeat(16)));
    const gzipped = zlib.gzipSync(body);

    await agent
      .post('/api/v1/traces/otlp')
      .set('Content-Type', 'application/x-protobuf')
      .set('Content-Encoding', 'gzip')
      .send(gzipped)
      .expect(200);

    const spans = await prisma.span.findMany({});
    expect(spans).toHaveLength(1);
  });

  it('accepts an OTLP/JSON body', async () => {
    const { agent } = await authedAgent(app);
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'e'.repeat(32),
                  spanId: 'f'.repeat(16),
                  name: 'ChatOpenAI',
                  startTimeUnixNano: '1700000000000000000',
                  attributes: [{ key: 'openinference.span.kind', value: { stringValue: 'LLM' } }],
                },
              ],
            },
          ],
        },
      ],
    };

    await agent
      .post('/api/v1/traces/otlp')
      .set('Content-Type', 'application/json')
      .send(payload)
      .expect(200);

    const spans = await prisma.span.findMany({});
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('llm');
  });

  it('ingests GenAI-semconv (gen_ai.*) spans as llm/retrieval spans with model, tokens, cost and session (issue #757)', async () => {
    const { agent } = await authedAgent(app);
    const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
    const int = (key: string, value: number) => ({ key, value: { intValue: String(value) } });
    const traceIdHex = '75'.repeat(16);
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [str('service.name', 'otel-genai-app')] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: traceIdHex,
                  spanId: '1'.repeat(16),
                  name: 'chat gpt-4o-mini',
                  startTimeUnixNano: '1700000000000000000',
                  endTimeUnixNano: '1700000000400000000',
                  attributes: [
                    str('gen_ai.operation.name', 'chat'),
                    str('gen_ai.provider.name', 'openai'),
                    str('gen_ai.request.model', 'gpt-4o-mini'),
                    int('gen_ai.usage.input_tokens', 1000),
                    int('gen_ai.usage.output_tokens', 200),
                    str('gen_ai.conversation.id', 'conv-757'),
                    str('gen_ai.input.messages', '[{"role":"user","parts":[{"type":"text","content":"hi"}]}]'),
                  ],
                },
                {
                  traceId: traceIdHex,
                  spanId: '2'.repeat(16),
                  parentSpanId: '1'.repeat(16),
                  name: 'retrieval docs',
                  startTimeUnixNano: '1700000000000000000',
                  attributes: [str('gen_ai.operation.name', 'retrieval')],
                },
                {
                  // Agent spans carry the summed usage of their child llm calls (spec). It
                  // must not be counted again on top of the chat span above.
                  traceId: traceIdHex,
                  spanId: '3'.repeat(16),
                  name: 'invoke_agent helper',
                  startTimeUnixNano: '1700000000000000000',
                  attributes: [
                    str('gen_ai.operation.name', 'invoke_agent'),
                    str('gen_ai.request.model', 'gpt-4o-mini'),
                    int('gen_ai.usage.input_tokens', 1000),
                    int('gen_ai.usage.output_tokens', 200),
                  ],
                },
                {
                  // The spec gives embeddings only an input count.
                  traceId: traceIdHex,
                  spanId: '4'.repeat(16),
                  parentSpanId: '1'.repeat(16),
                  name: 'embeddings text-embedding-3-small',
                  startTimeUnixNano: '1700000000000000000',
                  attributes: [
                    str('gen_ai.operation.name', 'embeddings'),
                    str('gen_ai.request.model', 'text-embedding-3-small'),
                    int('gen_ai.usage.input_tokens', 50),
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    await agent.post('/api/v1/traces/otlp').set('Content-Type', 'application/json').send(payload).expect(200);

    const chat = await prisma.span.findFirstOrThrow({ where: { spanRef: '1'.repeat(16) }, include: { payload: true } });
    expect(chat.kind).toBe('llm');
    expect(chat.model).toBe('gpt-4o-mini');
    expect(chat.provider).toBe('openai');
    expect(chat.promptTokens).toBe(1000);
    expect(chat.completionTokens).toBe(200);
    expect(chat.totalTokens).toBe(1200);
    // Priced from the built-in registry, so it now counts in cost analytics.
    expect(chat.costUsd).not.toBeNull();
    expect(Number(chat.costUsd)).toBeGreaterThan(0);
    // Message content went through the payload channel, not the raw attributes.
    expect(JSON.stringify(chat.attributes)).not.toContain('gen_ai.input.messages');
    expect(chat.payload?.input).toBe('[{"role":"user","parts":[{"type":"text","content":"hi"}]}]');

    const agentSpan = await prisma.span.findFirstOrThrow({ where: { spanRef: '3'.repeat(16) } });
    expect(agentSpan.kind).toBe('agent');
    expect(agentSpan.totalTokens).toBeNull();
    expect(agentSpan.costUsd).toBeNull();

    const embedding = await prisma.span.findFirstOrThrow({ where: { spanRef: '4'.repeat(16) } });
    expect(embedding.kind).toBe('embedding');
    // completion 0 is what makes it priceable; the built-in registry lists no embedding
    // models, so the cost itself comes from a team model price when one exists.
    expect(embedding.completionTokens).toBe(0);
    expect(embedding.totalTokens).toBe(50);

    const retrieval = await prisma.span.findFirstOrThrow({ where: { spanRef: '2'.repeat(16) } });
    expect(retrieval.kind).toBe('retrieval');

    const trace = await prisma.trace.findUniqueOrThrow({ where: { id: toUuid(traceIdHex) } });
    expect(trace.sessionId).toBe('conv-757');
    // chat 1200 + embedding 50; the agent span's aggregate is not added a second time.
    expect(trace.totalTokens).toBe(1250);
  });

  it("ingests Google ADK's legacy call_llm span as one llm call, counted once, with its content in the payload (issue #773)", async () => {
    const { agent } = await authedAgent(app);
    const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
    const int = (key: string, value: number) => ({ key, value: { intValue: String(value) } });
    const traceIdHex = '77'.repeat(16);
    const llmRequest = '{"model": "gemini-3.8-flash", "contents": [{"parts": [{"text": "What is the weather in Lahore?"}], "role": "user"}]}';
    // Shapes from a real google-adk 2.13.0 run with ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN=1.
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [str('service.name', 'adk-agent')] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: traceIdHex,
                  spanId: 'c'.repeat(16),
                  name: 'call_llm',
                  startTimeUnixNano: '1700000000000000000',
                  endTimeUnixNano: '1700000000900000000',
                  attributes: [
                    str('gen_ai.system', 'gcp.vertex.agent'),
                    str('gen_ai.request.model', 'gemini-3.8-flash'),
                    str('gcp.vertex.agent.session_id', 'adk-session-1'),
                    str('gcp.vertex.agent.llm_request', llmRequest),
                    str('gcp.vertex.agent.llm_response', '{"content":{"parts":[{"text":"Sunny, 24C."}],"role":"model"}}'),
                    int('gen_ai.usage.input_tokens', 93),
                    int('gen_ai.usage.output_tokens', 47),
                  ],
                },
                {
                  // ADK's own child span for the same model call, with the same counts.
                  traceId: traceIdHex,
                  spanId: 'd'.repeat(16),
                  parentSpanId: 'c'.repeat(16),
                  name: 'generate_content gemini-3.8-flash',
                  startTimeUnixNano: '1700000000100000000',
                  endTimeUnixNano: '1700000000800000000',
                  attributes: [
                    str('gen_ai.system', 'gemini'),
                    str('gen_ai.operation.name', 'generate_content'),
                    str('gen_ai.request.model', 'gemini-3.8-flash'),
                    int('gen_ai.usage.input_tokens', 93),
                    int('gen_ai.usage.output_tokens', 47),
                  ],
                },
                {
                  traceId: traceIdHex,
                  spanId: 'e'.repeat(16),
                  name: 'execute_tool get_weather',
                  startTimeUnixNano: '1700000001000000000',
                  attributes: [
                    str('gen_ai.operation.name', 'execute_tool'),
                    str('gen_ai.tool.name', 'get_weather'),
                    str('gcp.vertex.agent.llm_request', '{}'),
                    str('gcp.vertex.agent.llm_response', '{}'),
                    str('gcp.vertex.agent.tool_call_args', '{"city": "Lahore"}'),
                    str('gcp.vertex.agent.tool_response', '{"forecast": "sunny, 24C"}'),
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    await agent.post('/api/v1/traces/otlp').set('Content-Type', 'application/json').send(payload).expect(200);

    const callLlm = await prisma.span.findFirstOrThrow({ where: { spanRef: 'c'.repeat(16) }, include: { payload: true } });
    expect(callLlm.kind).toBe('llm');
    expect(callLlm.model).toBe('gemini-3.8-flash');
    expect(callLlm.provider).toBe('gemini');
    expect(callLlm.totalTokens).toBeNull();
    expect(callLlm.costUsd).toBeNull();
    expect(callLlm.payload?.input).toBe(llmRequest);
    expect(JSON.stringify(callLlm.attributes)).not.toContain('Lahore');

    const tool = await prisma.span.findFirstOrThrow({ where: { spanRef: 'e'.repeat(16) }, include: { payload: true } });
    expect(tool.kind).toBe('tool');
    expect(tool.payload?.input).toBe('{"city": "Lahore"}');
    expect(tool.payload?.output).toBe('{"forecast": "sunny, 24C"}');
    expect(JSON.stringify(tool.attributes)).not.toContain('Lahore');

    const trace = await prisma.trace.findUniqueOrThrow({ where: { id: toUuid(traceIdHex) } });
    // 93 + 47 from the generate_content child alone, not doubled by call_llm.
    expect(trace.totalTokens).toBe(140);
  });

  it('is safe to retry the exact same export batch (idempotent — no 500, no duplicate span)', async () => {
    const { agent } = await authedAgent(app);
    const body = await encodeRequest(crewAiPayload('1'.repeat(32), '2'.repeat(16)));

    await agent.post('/api/v1/traces/otlp').set('Content-Type', 'application/x-protobuf').send(body).expect(200);
    await agent.post('/api/v1/traces/otlp').set('Content-Type', 'application/x-protobuf').send(body).expect(200);

    const spans = await prisma.span.findMany({});
    expect(spans).toHaveLength(1);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const body = await encodeRequest(crewAiPayload('3'.repeat(32), '4'.repeat(16)));
    await request(app)
      .post('/api/v1/traces/otlp')
      .set('Content-Type', 'application/x-protobuf')
      .send(body)
      .expect(401);
  });

  it('rejects a malformed body with 400 VALIDATION_ERROR, not 500', async () => {
    const { agent } = await authedAgent(app);
    const res = await agent
      .post('/api/v1/traces/otlp')
      .set('Content-Type', 'application/x-protobuf')
      .send(Buffer.from('not a valid protobuf message', 'utf-8'))
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('chunks a trace with more than 200 spans instead of rejecting it', async () => {
    const { agent } = await authedAgent(app);
    const traceIdHex = '5'.repeat(32);
    const spans = Array.from({ length: 250 }, (_, i) => ({
      traceId: Buffer.from(traceIdHex, 'hex'),
      spanId: Buffer.from(i.toString(16).padStart(16, '0'), 'hex'),
      name: `span-${i}`,
      startTimeUnixNano: '1700000000000000000',
      attributes: [{ key: 'openinference.span.kind', value: { stringValue: 'CHAIN' } }],
    }));
    const body = await encodeRequest({
      resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans }] }],
    });

    await agent.post('/api/v1/traces/otlp').set('Content-Type', 'application/x-protobuf').send(body).expect(200);

    const expectedTraceId = `${traceIdHex.slice(0, 8)}-${traceIdHex.slice(8, 12)}-${traceIdHex.slice(12, 16)}-${traceIdHex.slice(16, 20)}-${traceIdHex.slice(20, 32)}`;
    const stored = await prisma.span.findMany({ where: { traceId: expectedTraceId } });
    expect(stored).toHaveLength(250);
    const trace = await prisma.trace.findUnique({ where: { id: expectedTraceId } });
    expect(trace?.spanCount).toBe(250);
  });

  it('accepts a child span exported before its parent (two separate batches) and links them once the parent lands', async () => {
    // The real BatchSpanProcessor timing: a leaf span ends first and flushes in
    // one export, the still-open root ends later and flushes in the next one.
    const { agent } = await authedAgent(app);
    const traceIdHex = '6'.repeat(32);
    const parentSpanIdHex = 'aa'.repeat(8);
    const childSpanIdHex = 'bb'.repeat(8);

    const childBody = await encodeRequest(
      spanPayload({
        traceIdHex,
        spanIdHex: childSpanIdHex,
        parentSpanIdHex,
        name: 'tool-call',
        startNano: '1700000000100000000',
      }),
    );
    await agent
      .post('/api/v1/traces/otlp')
      .set('Content-Type', 'application/x-protobuf')
      .send(childBody)
      .expect(200);

    // The orphan is stored, not rejected — a 400 here would be non-retryable.
    const afterChild = await prisma.span.findMany({});
    expect(afterChild).toHaveLength(1);
    expect(afterChild[0].parentSpanRef).toBe(parentSpanIdHex);

    const parentBody = await encodeRequest(
      spanPayload({
        traceIdHex,
        spanIdHex: parentSpanIdHex,
        name: 'CrewAgentExecutor.invoke',
        startNano: '1700000000000000000',
      }),
    );
    await agent
      .post('/api/v1/traces/otlp')
      .set('Content-Type', 'application/x-protobuf')
      .send(parentBody)
      .expect(200);

    const traceId = toUuid(traceIdHex);
    const stored = await prisma.span.findMany({ where: { traceId } });
    expect(stored).toHaveLength(2);

    // The queried tree now has one root with the late-arriving child under it.
    const detail = await agent.get(`/api/v1/traces/${traceId}`).expect(200);
    expect(detail.body.spans).toHaveLength(1);
    expect(detail.body.spans[0].spanId).toBe(parentSpanIdHex);
    expect(detail.body.spans[0].children).toHaveLength(1);
    expect(detail.body.spans[0].children[0].spanId).toBe(childSpanIdHex);
  });

  it('names the trace after its root span rather than a timestamp (issue #362)', async () => {
    // The trace list and the session detail view both show the trace name, and it was an
    // ISO timestamp for every OTLP-ingested trace — so the column read as a wall of
    // near-identical timestamps for exactly the users who wrote no AcruxCore code.
    const { agent } = await authedAgent(app);
    const traceIdHex = 'a1'.repeat(16);
    const body = await encodeRequest(crewAiPayload(traceIdHex, 'cc'.repeat(8)));

    await agent
      .post('/api/v1/traces/otlp')
      .set('Content-Type', 'application/x-protobuf')
      .send(body)
      .expect(200);

    const trace = await prisma.trace.findUnique({ where: { id: toUuid(traceIdHex) } });
    expect(trace!.name).toBe('CrewAgentExecutor.invoke');
  });

  it('upgrades a timestamp name when the root span arrives in a later batch', async () => {
    // The real BatchSpanProcessor timing again: the leaf flushes first and creates the
    // trace, so the batch that names it is not the batch that created it.
    const { agent } = await authedAgent(app);
    const traceIdHex = 'a2'.repeat(16);
    const rootSpanIdHex = 'aa'.repeat(8);
    const traceId = toUuid(traceIdHex);

    const child = await encodeRequest(
      spanPayload({
        traceIdHex, spanIdHex: 'bb'.repeat(8), parentSpanIdHex: rootSpanIdHex,
        name: 'tool-call', startNano: '1700000000100000000',
      }),
    );
    await agent.post('/api/v1/traces/otlp').set('Content-Type', 'application/x-protobuf').send(child).expect(200);

    // The child names nothing — it has a parent, so it is not the run. The trace keeps the
    // Q12 timestamp fallback until the root lands.
    const provisional = (await prisma.trace.findUnique({ where: { id: traceId } }))!.name;
    expect(provisional).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const root = await encodeRequest(
      spanPayload({
        traceIdHex, spanIdHex: rootSpanIdHex,
        name: 'Crew_5f1fcf48-de64-42cf-b927-5c060836053', startNano: '1700000000000000000',
      }),
    );
    await agent.post('/api/v1/traces/otlp').set('Content-Type', 'application/x-protobuf').send(root).expect(200);

    expect((await prisma.trace.findUnique({ where: { id: traceId } }))!.name).toBe('Crew');
  });

  it('never pushes a real trace name back to a derived one', async () => {
    // A trace named through the native ingest path (a caller's explicit instruction) must
    // survive an OTLP batch landing on the same trace id. Without the placeholder guard,
    // a derived name would win simply by arriving later.
    const { agent } = await authedAgent(app);
    const traceIdHex = 'a3'.repeat(16);
    const traceId = toUuid(traceIdHex);

    await agent
      .post('/api/v1/traces')
      .send({
        traces: [{
          traceId,
          name: 'nightly-itinerary-run',
          spans: [{ spanId: 'seed', name: 'seed', kind: 'other', startTime: '2026-08-21T10:00:00.000Z' }],
        }],
      })
      .expect(200);

    const body = await encodeRequest(crewAiPayload(traceIdHex, 'cc'.repeat(8)));
    await agent.post('/api/v1/traces/otlp').set('Content-Type', 'application/x-protobuf').send(body).expect(200);

    expect((await prisma.trace.findUnique({ where: { id: traceId } }))!.name).toBe('nightly-itinerary-run');
  });

  it('rejects an export carrying more spans than the per-request ceiling with 413', async () => {
    const { agent } = await authedAgent(app);
    const traceIdHex = '7'.repeat(32);
    const spans = Array.from({ length: 2001 }, (_, i) => ({
      traceId: Buffer.from(traceIdHex, 'hex'),
      spanId: Buffer.from(i.toString(16).padStart(16, '0'), 'hex'),
      name: `span-${i}`,
      startTimeUnixNano: '1700000000000000000',
      attributes: [{ key: 'openinference.span.kind', value: { stringValue: 'CHAIN' } }],
    }));
    const body = await encodeRequest({
      resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans }] }],
    });

    const res = await agent
      .post('/api/v1/traces/otlp')
      .set('Content-Type', 'application/x-protobuf')
      .send(body)
      .expect(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');

    // Nothing was written — the whole export is refused before ingestion starts.
    expect(await prisma.span.count()).toBe(0);
  });

  it('accepts an OTLP/JSON body far larger than the app-wide 100KB json limit', async () => {
    const { agent } = await authedAgent(app);
    // ~600KB of attribute text: over express.json()'s 100KB default, under 10mb.
    const filler = 'x'.repeat(2000);
    const spans = Array.from({ length: 300 }, (_, i) => ({
      traceId: '8'.repeat(32),
      spanId: i.toString(16).padStart(16, '0'),
      name: `span-${i}`,
      startTimeUnixNano: '1700000000000000000',
      attributes: [
        { key: 'openinference.span.kind', value: { stringValue: 'CHAIN' } },
        { key: 'custom.filler', value: { stringValue: filler } },
      ],
    }));
    const payload = { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans }] }] };
    expect(JSON.stringify(payload).length).toBeGreaterThan(100 * 1024);

    await agent
      .post('/api/v1/traces/otlp')
      .set('Content-Type', 'application/json')
      .send(payload)
      .expect(200);

    expect(await prisma.span.count()).toBe(300);
  });
});
