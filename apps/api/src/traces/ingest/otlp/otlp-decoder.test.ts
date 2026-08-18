import path from 'path';
import protobuf from 'protobufjs';
import Long from 'long';
import { decodeOtlpProtobuf } from './otlp-decoder';

const PROTO_ROOT = path.join(__dirname, 'proto');

/** Encodes a minimal real ExportTraceServiceRequest using the same vendored
 * .proto definitions the decoder uses — a genuine wire-format artifact, not a
 * mock of the decoder's behavior. */
async function encodeSampleRequest(): Promise<Buffer> {
  const root = new protobuf.Root();
  // Custom resolver to handle imports relative to the proto root
  root.resolvePath = (origin: string, target: string) => {
    if (target.startsWith('opentelemetry/proto/')) {
      return path.join(PROTO_ROOT, target);
    }
    return path.resolve(path.dirname(origin), target);
  };
  await root.load(
    path.join(PROTO_ROOT, 'opentelemetry/proto/collector/trace/v1/trace_service.proto'),
  );
  const ExportTraceServiceRequest = root.lookupType(
    'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
  );
  const traceIdHex = 'a'.repeat(32);
  const spanIdHex = 'b'.repeat(16);
  const payload = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'crewai-app' } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: Buffer.from(traceIdHex, 'hex'),
                spanId: Buffer.from(spanIdHex, 'hex'),
                name: 'CrewAgentExecutor.invoke',
                startTimeUnixNano: Long.fromString('1700000000000000000'),
                endTimeUnixNano: Long.fromString('1700000000500000000'),
                attributes: [{ key: 'openinference.span.kind', value: { stringValue: 'AGENT' } }],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
  const errMsg = ExportTraceServiceRequest.verify(payload);
  if (errMsg) throw new Error(errMsg);
  const message = ExportTraceServiceRequest.create(payload);
  return Buffer.from(ExportTraceServiceRequest.encode(message).finish());
}

describe('decodeOtlpProtobuf', () => {
  it('round-trips a real encoded ExportTraceServiceRequest', async () => {
    const buffer = await encodeSampleRequest();
    const decoded = decodeOtlpProtobuf(buffer);

    expect(decoded).toHaveLength(1);
    expect(decoded[0].resourceAttributes).toEqual([
      { key: 'service.name', value: { stringValue: 'crewai-app' } },
    ]);
    expect(decoded[0].spans).toHaveLength(1);
    const span = decoded[0].spans[0];
    expect(span.traceId).toBe('a'.repeat(32));
    expect(span.spanId).toBe('b'.repeat(16));
    expect(span.name).toBe('CrewAgentExecutor.invoke');
    expect(span.startTimeUnixNano).toBe('1700000000000000000');
    expect(span.endTimeUnixNano).toBe('1700000000500000000');
    expect(span.attributes).toEqual([
      { key: 'openinference.span.kind', value: { stringValue: 'AGENT' } },
    ]);
    expect(span.status).toEqual({ code: 1 });
  });
});

import { decodeOtlpJson } from './otlp-decoder';

describe('decodeOtlpJson', () => {
  it('parses an OTLP/JSON ExportTraceServiceRequest body', () => {
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'langchain-app' } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'a'.repeat(32),
                  spanId: 'b'.repeat(16),
                  name: 'ChatOpenAI',
                  startTimeUnixNano: '1700000000000000000',
                  endTimeUnixNano: '1700000000250000000',
                  attributes: [{ key: 'openinference.span.kind', value: { stringValue: 'LLM' } }],
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    };

    const decoded = decodeOtlpJson(body);

    expect(decoded).toHaveLength(1);
    expect(decoded[0].spans).toHaveLength(1);
    expect(decoded[0].spans[0].traceId).toBe('a'.repeat(32));
    expect(decoded[0].spans[0].name).toBe('ChatOpenAI');
  });

  it('throws on a body missing resourceSpans', () => {
    expect(() => decodeOtlpJson({})).toThrow();
  });

  it('rejects a malformed trace_id with a message naming the expected shape', () => {
    const body = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'abc123', // 6 chars, not 32
                  spanId: 'b'.repeat(16),
                  name: 'ChatOpenAI',
                  startTimeUnixNano: '1700000000000000000',
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(() => decodeOtlpJson(body)).toThrow(
      'Invalid OTLP trace_id: expected 32 hex characters, got "abc123".',
    );
  });

  it('rejects a malformed span_id', () => {
    const body = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'a'.repeat(32),
                  spanId: 'zzzzzzzzzzzzzzzz', // right length, not hex
                  name: 'ChatOpenAI',
                  startTimeUnixNano: '1700000000000000000',
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(() => decodeOtlpJson(body)).toThrow(/Invalid OTLP span_id: expected 16 hex characters/);
  });
});
