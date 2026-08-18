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
