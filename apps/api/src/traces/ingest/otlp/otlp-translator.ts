import type { IngestSpan, IngestTrace, SpanKind, SpanStatus } from '../ingest.types';
import { computeCost, resolveProvider } from '../../../gateway/providers/models';
import type { RawAnyValue, RawKeyValue, RawResourceSpans, RawSpan } from './otlp.types';

const OPENINFERENCE_KIND_MAP: Record<string, SpanKind> = {
  LLM: 'llm',
  TOOL: 'tool',
  RETRIEVER: 'retrieval',
  EMBEDDING: 'embedding',
  AGENT: 'agent',
  CHAIN: 'chain',
};

/** Unwraps an OTel `AnyValue` oneof into a plain JS value. */
function unwrapValue(value: RawAnyValue): unknown {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  // `?? []` is load-bearing: protobufjs omits an empty repeated field, so an
  // empty OTel list attribute arrives as `{ arrayValue: {} }` with no `values`.
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(unwrapValue);
  if (value.kvlistValue) return attributesToRecord(value.kvlistValue.values ?? []);
  return undefined;
}

/** Converts an OTel attribute list into a plain `{ key: value }` record. */
function attributesToRecord(attrs: RawKeyValue[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const attr of attrs) record[attr.key] = unwrapValue(attr.value);
  return record;
}

/** Converts OTel's decimal-string nanosecond epoch timestamp into ISO-8601. */
function nanosToIso(nanos: string): string {
  const ms = BigInt(nanos) / 1_000_000n;
  return new Date(Number(ms)).toISOString();
}

/** Reformats a 32-hex-char OTel trace id into UUID dash-shape. */
function traceIdToUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const STATUS_MAP: Record<number, SpanStatus> = { 0: 'unset', 1: 'ok', 2: 'error' };

/** Maps OTel's `Status.code` (absent when UNSET — proto3 omits zero values) onto a SpanStatus. */
function mapStatus(status: RawSpan['status']): SpanStatus {
  if (!status || status.code === undefined) return 'unset';
  return STATUS_MAP[status.code] ?? 'unset';
}

/**
 * OpenInference attribute keys (exact matches and prefixes) that carry prompt or
 * completion text. They are deliberately kept OUT of `span.attributes`, which is
 * persisted verbatim and unredacted regardless of the team's `capturePayloads`
 * setting — storing them there would be a second, ungated channel around
 * `SpansRepository.writePayload`, the single redaction choke point. The same
 * content still reaches storage through `span.input`/`span.output`, which the
 * capture gate and redaction both apply to.
 */
const PAYLOAD_ATTRIBUTE_KEYS = ['input.value', 'output.value'];
const PAYLOAD_ATTRIBUTE_PREFIXES = ['llm.input_messages.', 'llm.output_messages.', 'retrieval.documents.'];

/** Returns a copy of `attrs` with every payload-bearing OpenInference key removed. */
function stripPayloadAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (PAYLOAD_ATTRIBUTE_KEYS.includes(key)) continue;
    if (PAYLOAD_ATTRIBUTE_PREFIXES.some((p) => key.startsWith(p))) continue;
    safe[key] = value;
  }
  return safe;
}

/** Matches OpenInference's flattened `retrieval.documents.{index}.document.{field}` keys. */
const RETRIEVAL_DOCUMENT_KEY = /^retrieval\.documents\.(\d+)\.document\.(.+)$/;

/**
 * Reassembles OpenInference's flattened `retrieval.documents.{i}.document.{field}`
 * attributes into an ordered array of document objects, one per index.
 *
 * On a RETRIEVER-kind span, `input.value` holds only the search query — the actual
 * retrieved document content lives solely in these flattened attributes, which
 * `stripPayloadAttributes` removes. Without this promotion that content would be
 * silently dropped instead of flowing through `span.output`'s capture-gate and
 * redaction channel like every other payload.
 *
 * @param attrs - The span's raw (pre-strip) attribute record.
 * @returns An array of document objects ordered by index, or `undefined` when no
 *   `retrieval.documents.*` attributes are present.
 */
function reassembleRetrievalDocuments(attrs: Record<string, unknown>): unknown[] | undefined {
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const [key, value] of Object.entries(attrs)) {
    const match = RETRIEVAL_DOCUMENT_KEY.exec(key);
    if (!match) continue;
    const index = Number(match[1]);
    const field = match[2];
    if (!byIndex.has(index)) byIndex.set(index, {});
    byIndex.get(index)![field] = value;
  }
  if (byIndex.size === 0) return undefined;
  return Array.from(byIndex.entries())
    .sort(([a], [b]) => a - b)
    .map(([, doc]) => doc);
}

/**
 * Resolves the value to promote into `span.output`: the OpenInference `output.value`
 * attribute when present, otherwise the reassembled `retrieval.documents.*` array
 * (see {@link reassembleRetrievalDocuments}) — never both, so a real `output.value`
 * is never overwritten.
 */
function resolveOutput(attrs: Record<string, unknown>): unknown {
  if (attrs['output.value'] !== undefined) return attrs['output.value'];
  return reassembleRetrievalDocuments(attrs);
}

/** Maps one raw OTel span, tagged with the OpenInference attribute vocabulary, to an `IngestSpan`. */
function mapOpenInferenceSpan(raw: RawSpan, attrs: Record<string, unknown>): IngestSpan {
  const kindRaw = String(attrs['openinference.span.kind']);
  const kind = OPENINFERENCE_KIND_MAP[kindRaw] ?? 'other';
  const model = typeof attrs['llm.model_name'] === 'string' ? (attrs['llm.model_name'] as string) : undefined;
  const promptTokens = typeof attrs['llm.token_count.prompt'] === 'number' ? attrs['llm.token_count.prompt'] as number : undefined;
  const completionTokens = typeof attrs['llm.token_count.completion'] === 'number' ? attrs['llm.token_count.completion'] as number : undefined;
  const totalTokens = typeof attrs['llm.token_count.total'] === 'number' ? attrs['llm.token_count.total'] as number : undefined;
  const provider =
    (typeof attrs['llm.provider'] === 'string' && (attrs['llm.provider'] as string)) ||
    (typeof attrs['llm.system'] === 'string' && (attrs['llm.system'] as string)) ||
    (model ? resolveProvider(model) ?? undefined : undefined);
  const costUsd =
    model && promptTokens !== undefined && completionTokens !== undefined
      ? computeCost(model, {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          // `computeCost` only reads prompt/completion tokens, but `Usage` requires
          // `total_tokens` — fall back to the sum when OTel didn't report one.
          total_tokens: totalTokens ?? promptTokens + completionTokens,
        }) ?? undefined
      : undefined;

  return {
    spanId: raw.spanId,
    parentSpanId: raw.parentSpanId,
    name: raw.name,
    kind,
    status: mapStatus(raw.status),
    startTime: nanosToIso(raw.startTimeUnixNano),
    endTime: raw.endTimeUnixNano ? nanosToIso(raw.endTimeUnixNano) : undefined,
    model,
    provider,
    usage:
      promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined
        ? { promptTokens, completionTokens, totalTokens }
        : undefined,
    costUsd,
    input: attrs['input.value'],
    output: resolveOutput(attrs),
    attributes: stripPayloadAttributes(attrs),
    error: raw.status?.code === 2 ? raw.status.message : undefined,
  };
}

/**
 * Maps a raw OTel span with no recognized attribute vocabulary. Nothing is lost:
 * payload-bearing keys move to `input`/`output` (so the capture gate and
 * redaction apply) instead of riding along in the unredacted `attributes` blob;
 * everything else is preserved verbatim.
 */
function mapGenericSpan(raw: RawSpan, attrs: Record<string, unknown>): IngestSpan {
  return {
    spanId: raw.spanId,
    parentSpanId: raw.parentSpanId,
    name: raw.name,
    kind: 'other',
    status: mapStatus(raw.status),
    startTime: nanosToIso(raw.startTimeUnixNano),
    endTime: raw.endTimeUnixNano ? nanosToIso(raw.endTimeUnixNano) : undefined,
    input: attrs['input.value'],
    output: resolveOutput(attrs),
    attributes: stripPayloadAttributes(attrs),
    error: raw.status?.code === 2 ? raw.status.message : undefined,
  };
}

/**
 * Translates decoded OTLP `ResourceSpans` into AcruxCore's `IngestTrace[]` shape,
 * grouping spans by trace id (Phase 1: OpenInference vocabulary only — see the
 * design doc for the Phase 2 GenAI-semconv gap).
 *
 * @param resourceSpans - Decoded OTLP resource/span groups (protobuf or JSON path).
 * @returns One `IngestTrace` per distinct trace id found across all resources.
 */
export function translateResourceSpans(resourceSpans: RawResourceSpans[]): IngestTrace[] {
  const byTraceId = new Map<string, IngestSpan[]>();
  const sessionByTraceId = new Map<string, string>();

  for (const rs of resourceSpans) {
    for (const raw of rs.spans) {
      const attrs = attributesToRecord(raw.attributes);
      const isOpenInference = 'openinference.span.kind' in attrs;
      const span = isOpenInference ? mapOpenInferenceSpan(raw, attrs) : mapGenericSpan(raw, attrs);

      const traceId = traceIdToUuid(raw.traceId);
      if (!byTraceId.has(traceId)) byTraceId.set(traceId, []);
      byTraceId.get(traceId)!.push(span);

      if (typeof attrs['session.id'] === 'string' && !sessionByTraceId.has(traceId)) {
        sessionByTraceId.set(traceId, attrs['session.id'] as string);
      }
    }
  }

  return Array.from(byTraceId.entries()).map(([traceId, spans]) => ({
    traceId,
    sessionId: sessionByTraceId.get(traceId),
    spans,
  }));
}
