import path from 'path';
import protobuf, { Root } from 'protobufjs';
import type { RawResourceSpans } from './otlp.types';

const PROTO_ROOT = path.join(__dirname, 'proto');

let cachedRoot: Root | null = null;

/** Lazily loads and caches the vendored OTLP proto definitions. */
function loadRoot(): Root {
  if (!cachedRoot) {
    const root = new protobuf.Root();
    // Custom resolver to handle imports relative to the proto root
    root.resolvePath = (origin: string, target: string) => {
      if (target.startsWith('opentelemetry/proto/')) {
        return path.join(PROTO_ROOT, target);
      }
      return path.resolve(path.dirname(origin), target);
    };
    cachedRoot = root.loadSync(
      path.join(PROTO_ROOT, 'opentelemetry/proto/collector/trace/v1/trace_service.proto'),
    );
  }
  return cachedRoot;
}

const TRACE_ID_HEX = /^[0-9a-f]{32}$/i;
const SPAN_ID_HEX = /^[0-9a-f]{16}$/i;

/**
 * Asserts that a decoded span's ids are well-formed OTel hex ids before anything
 * downstream treats a trace id as a UUID. Without this a truncated or base64
 * id silently becomes a garbage "UUID" and surfaces as an opaque Prisma error
 * deep in ingestion instead of a clean 400 at the wire boundary.
 *
 * @param span - The just-decoded span, with ids already rendered as hex strings.
 * @throws {Error} If any id is not the exact hex length OTel mandates. A plain
 *   `Error` on purpose — {@link OtlpService} maps decode failures to a 400.
 */
function assertValidIds(span: { traceId: string; spanId: string; parentSpanId?: string }): void {
  if (typeof span.traceId !== 'string' || !TRACE_ID_HEX.test(span.traceId)) {
    throw new Error(`Invalid OTLP trace_id: expected 32 hex characters, got "${String(span.traceId)}".`);
  }
  if (typeof span.spanId !== 'string' || !SPAN_ID_HEX.test(span.spanId)) {
    throw new Error(`Invalid OTLP span_id: expected 16 hex characters, got "${String(span.spanId)}".`);
  }
  if (span.parentSpanId !== undefined && !SPAN_ID_HEX.test(span.parentSpanId)) {
    throw new Error(
      `Invalid OTLP parent_span_id: expected 16 hex characters, got "${String(span.parentSpanId)}".`,
    );
  }
}

/**
 * Decodes a raw OTLP/HTTP protobuf body (`application/x-protobuf`) into the
 * intermediate `RawResourceSpans` shape shared with the JSON decode path.
 *
 * @param buffer - The raw request body (already gunzipped by body-parser's
 *   `inflate` behavior when `Content-Encoding: gzip` was set).
 * @returns One entry per `ResourceSpans` in the request, `scopeSpans` flattened
 *   into a single `spans` array (AcruxCore has no concept of instrumentation scope).
 * @throws {Error} If the buffer is not a valid `ExportTraceServiceRequest`, or
 *   if any span carries a malformed trace/span id.
 */
export function decodeOtlpProtobuf(buffer: Buffer): RawResourceSpans[] {
  const root = loadRoot();
  const ExportTraceServiceRequest = root.lookupType(
    'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
  );
  const message = ExportTraceServiceRequest.decode(buffer);
  const obj = ExportTraceServiceRequest.toObject(message, {
    longs: String,
    enums: Number,
    bytes: Buffer,
  });

  // `any` here is genuinely unavoidable: protobufjs's `toObject()` return type is
  // a loosely-typed plain object by design (it reflects whatever the loaded
  // .proto schema describes at runtime, not a compile-time-known shape) — casting
  // is how every protobufjs consumer bridges into a typed shape.
  return (obj.resourceSpans ?? []).map((rs: any) => ({
    resourceAttributes: rs.resource?.attributes ?? [],
    spans: (rs.scopeSpans ?? []).flatMap((ss: any) =>
      (ss.spans ?? []).map((s: any) => {
        const span = {
          traceId: (s.traceId as Buffer).toString('hex'),
          spanId: (s.spanId as Buffer).toString('hex'),
          parentSpanId:
            s.parentSpanId && (s.parentSpanId as Buffer).length > 0
              ? (s.parentSpanId as Buffer).toString('hex')
              : undefined,
          name: s.name,
          startTimeUnixNano: s.startTimeUnixNano,
          endTimeUnixNano:
            s.endTimeUnixNano && s.endTimeUnixNano !== '0' ? s.endTimeUnixNano : undefined,
          attributes: s.attributes ?? [],
          status: s.status,
        };
        assertValidIds(span);
        return span;
      }),
    ),
  }));
}

/**
 * Parses an OTLP/JSON body into the same `RawResourceSpans` shape the protobuf
 * decoder produces. OTLP/JSON mirrors the protobuf field names directly and
 * represents `trace_id`/`span_id` as hex strings (a documented deviation from
 * plain proto3-JSON's base64-for-bytes default) — verify this against one real
 * captured payload before this path is exercised in production; see the design
 * doc's Phase 1 "flagged for empirical verification" note.
 *
 * @param body - The parsed JSON request body.
 * @returns One entry per resourceSpans object, spans flattened the same way as the protobuf path.
 * @throws {Error} If `resourceSpans` is missing or not an array, or if any span
 *   carries a malformed trace/span id.
 */
export function decodeOtlpJson(body: unknown): RawResourceSpans[] {
  const obj = body as { resourceSpans?: unknown };
  if (!Array.isArray(obj.resourceSpans)) {
    throw new Error('OTLP/JSON body is missing a `resourceSpans` array.');
  }
  // `any` here for the same reason as the protobuf path: this is an untyped,
  // externally-supplied JSON body, not a shape TypeScript can know at compile time.
  return (obj.resourceSpans as any[]).map((rs) => ({
    resourceAttributes: rs.resource?.attributes ?? [],
    spans: (rs.scopeSpans ?? []).flatMap((ss: any) =>
      (ss.spans ?? []).map((s: any) => {
        const span = {
          traceId: s.traceId,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId || undefined,
          name: s.name,
          startTimeUnixNano: s.startTimeUnixNano,
          endTimeUnixNano:
            s.endTimeUnixNano && s.endTimeUnixNano !== '0' ? s.endTimeUnixNano : undefined,
          attributes: s.attributes ?? [],
          status: s.status,
        };
        assertValidIds(span);
        return span;
      }),
    ),
  }));
}
