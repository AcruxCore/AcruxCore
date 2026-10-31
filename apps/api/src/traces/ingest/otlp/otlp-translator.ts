import { UsageSchema, type IngestSpan, type IngestTrace, type SpanKind, type SpanStatus } from '../ingest.types';
import { resolveProvider } from '../../../gateway/providers/models';
import type { RawAnyValue, RawKeyValue, RawResourceSpans, RawSpan } from './otlp.types';

const OPENINFERENCE_KIND_MAP: Record<string, SpanKind> = {
  LLM: 'llm',
  TOOL: 'tool',
  RETRIEVER: 'retrieval',
  EMBEDDING: 'embedding',
  AGENT: 'agent',
  CHAIN: 'chain',
};

/**
 * `gen_ai.operation.name` values from the OpenTelemetry GenAI semantic conventions,
 * mapped onto our span kinds. An operation not listed here (a newer one the spec adds
 * later) lands as `other`, but its model and token counts are still read.
 */
const GEN_AI_OPERATION_KIND_MAP: Record<string, SpanKind> = {
  chat: 'llm',
  text_completion: 'llm',
  generate_content: 'llm',
  embeddings: 'embedding',
  execute_tool: 'tool',
  invoke_agent: 'agent',
  create_agent: 'agent',
  retrieval: 'retrieval',
  invoke_workflow: 'chain',
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
 * Attribute keys that carry prompt, completion, tool-call or retrieval text, in the
 * OpenInference, GenAI-semconv and OpenLLMetry vocabularies. They are deliberately kept OUT
 * of `span.attributes`, which is persisted verbatim and unredacted regardless of the team's
 * `capturePayloads` setting — storing them there would be a second, ungated channel around
 * `SpansRepository.writePayload`, the single redaction choke point. The same content still
 * reaches storage through `span.input`/`span.output`, which the capture gate and redaction
 * both apply to.
 *
 * Each key here is also listed as an input or output source below, so nothing that is
 * stripped is lost.
 */
const PAYLOAD_ATTRIBUTE_KEYS = new Set([
  'input.value',
  'output.value',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.prompt',
  'gen_ai.completion',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.retrieval.query.text',
  'gen_ai.retrieval.documents',
  'traceloop.entity.input',
  'traceloop.entity.output',
  'gcp.vertex.agent.llm_request',
  'gcp.vertex.agent.llm_response',
  'gcp.vertex.agent.tool_call_args',
  'gcp.vertex.agent.tool_response',
  'gcp.vertex.agent.data',
]);

/**
 * Values Google ADK writes into its `gcp.vertex.agent.*` content keys when there is nothing
 * to record: `{}` when content capture is off or the key does not apply to the span (a tool
 * span still gets an empty `llm_request`), and `N/A` on a merged tool call. Reading them as
 * content would put a meaningless `{}` in the payload, or turn a single real source into an
 * object keyed by source name.
 */
const ADK_PLACEHOLDER_VALUES = new Set(['{}', 'N/A']);

/** An ADK `gcp.vertex.agent.*` content attribute, or `undefined` when absent or a placeholder. */
function adkContent(attrs: Record<string, unknown>, key: string): unknown {
  const value = attrs[key];
  return typeof value === 'string' && ADK_PLACEHOLDER_VALUES.has(value) ? undefined : value;
}

/** Matches OpenInference's flattened `retrieval.documents.{index}.document.{field}` keys. */
const RETRIEVAL_DOCUMENT_KEY = /^retrieval\.documents\.(\d+)\.document\.(.+)$/;

/** Matches OpenLLMetry's flattened `gen_ai.prompt.{index}.{field}` keys. */
const GEN_AI_PROMPT_KEY = /^gen_ai\.prompt\.(\d+)\.(.+)$/;

/** Matches OpenLLMetry's flattened `gen_ai.completion.{index}.{field}` keys. */
const GEN_AI_COMPLETION_KEY = /^gen_ai\.completion\.(\d+)\.(.+)$/;

/**
 * Flattened payload keys. Only the indexed shapes are stripped: a plain prefix such as
 * `gen_ai.prompt.` would also remove `gen_ai.prompt.name`, a template name that is metadata
 * and is never reassembled anywhere.
 */
const PAYLOAD_ATTRIBUTE_PATTERNS = [
  /^llm\.input_messages\./,
  /^llm\.output_messages\./,
  RETRIEVAL_DOCUMENT_KEY,
  GEN_AI_PROMPT_KEY,
  GEN_AI_COMPLETION_KEY,
];

/** Returns a copy of `attrs` with every payload-bearing attribute key removed. */
function stripPayloadAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (PAYLOAD_ATTRIBUTE_KEYS.has(key)) continue;
    if (PAYLOAD_ATTRIBUTE_PATTERNS.some((p) => p.test(key))) continue;
    safe[key] = value;
  }
  return safe;
}

/**
 * Rebuilds an ordered array of objects from flattened `prefix.{index}.{field}` keys.
 *
 * @param attrs - The span's raw (pre-strip) attribute record.
 * @param pattern - A regex whose first group is the index and second group the field name.
 * @returns One object per index, ordered by index, or `undefined` when no key matches.
 */
function reassembleIndexed(attrs: Record<string, unknown>, pattern: RegExp): unknown[] | undefined {
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const [key, value] of Object.entries(attrs)) {
    const match = pattern.exec(key);
    if (!match) continue;
    const index = Number(match[1]);
    if (!byIndex.has(index)) byIndex.set(index, {});
    byIndex.get(index)![match[2]] = value;
  }
  if (byIndex.size === 0) return undefined;
  return Array.from(byIndex.entries())
    .sort(([a], [b]) => a - b)
    .map(([, item]) => item);
}

/**
 * Combines every present content source into one payload value. One source is returned
 * as-is, which is the common case. Several are returned as an object keyed by source
 * name, because the sources are all stripped from `attributes` and keeping only the
 * first would silently drop the rest.
 */
function mergeSources(sources: Array<[string, unknown]>): unknown {
  const present = sources.filter(([, value]) => value !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0][1];
  return Object.fromEntries(present);
}

/**
 * The span's input, from whichever vocabulary carries it: OpenInference `input.value`,
 * GenAI messages (current, older, or OpenLLMetry's flattened keys), tool-call arguments,
 * a retrieval query, or OpenLLMetry's entity input. System instructions, which the current
 * GenAI spec keeps in their own attribute, sit beside the messages so they are not lost.
 * Google ADK's legacy schema puts the request, tool arguments and sent data in
 * `gcp.vertex.agent.*` keys instead.
 */
function resolveInput(attrs: Record<string, unknown>): unknown {
  const messages = mergeSources([
    ['input.value', attrs['input.value']],
    ['gen_ai.input.messages', attrs['gen_ai.input.messages']],
    ['gen_ai.prompt', attrs['gen_ai.prompt']],
    ['gen_ai.prompt.*', reassembleIndexed(attrs, GEN_AI_PROMPT_KEY)],
    ['gen_ai.tool.call.arguments', attrs['gen_ai.tool.call.arguments']],
    ['gen_ai.retrieval.query.text', attrs['gen_ai.retrieval.query.text']],
    ['traceloop.entity.input', attrs['traceloop.entity.input']],
    ['gcp.vertex.agent.llm_request', adkContent(attrs, 'gcp.vertex.agent.llm_request')],
    ['gcp.vertex.agent.tool_call_args', adkContent(attrs, 'gcp.vertex.agent.tool_call_args')],
    ['gcp.vertex.agent.data', adkContent(attrs, 'gcp.vertex.agent.data')],
  ]);
  const system = attrs['gen_ai.system_instructions'];
  return system === undefined ? messages : { system_instructions: system, messages };
}

/**
 * The span's output; the counterpart of {@link resolveInput}. On an OpenInference
 * RETRIEVER span the retrieved documents live only in the flattened
 * `retrieval.documents.*` keys, so they are reassembled here when there is no
 * `output.value`.
 */
function resolveOutput(attrs: Record<string, unknown>): unknown {
  return mergeSources([
    // OpenInference: a real `output.value` wins over the reassembled documents, never both.
    ['output.value', attrs['output.value'] ?? reassembleIndexed(attrs, RETRIEVAL_DOCUMENT_KEY)],
    ['gen_ai.output.messages', attrs['gen_ai.output.messages']],
    ['gen_ai.completion', attrs['gen_ai.completion']],
    ['gen_ai.completion.*', reassembleIndexed(attrs, GEN_AI_COMPLETION_KEY)],
    ['gen_ai.tool.call.result', attrs['gen_ai.tool.call.result']],
    ['gen_ai.retrieval.documents', attrs['gen_ai.retrieval.documents']],
    ['traceloop.entity.output', attrs['traceloop.entity.output']],
    ['gcp.vertex.agent.llm_response', adkContent(attrs, 'gcp.vertex.agent.llm_response')],
    ['gcp.vertex.agent.tool_response', adkContent(attrs, 'gcp.vertex.agent.tool_response')],
  ]);
}

/** Returns the attribute when it is a non-empty string, otherwise `undefined`. */
function stringAttr(attrs: Record<string, unknown>, key: string): string | undefined {
  const value = attrs[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Returns the first of `keys` whose value is a valid token count: a non-negative integer.
 * Anything else is ignored rather than passed on, because the OTLP path does not run the
 * native ingest schema and a fractional count would make the integer column throw.
 */
function tokenAttr(attrs: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  }
  return undefined;
}

/**
 * Looks up `key` in a kind map, ignoring inherited `Object.prototype` members. A plain
 * index would turn an attribute value of `constructor` into a function, which Prisma then
 * rejects as a span kind, failing the whole export batch with a 500.
 */
function lookupKind(map: Record<string, SpanKind>, key: string | undefined): SpanKind {
  return key !== undefined && Object.hasOwn(map, key) ? map[key] : 'other';
}

interface UsageCounts {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
}

/**
 * Builds a span's `usage` through the native path's own `UsageSchema`, so both paths
 * apply the same rule to a cache-read count larger than the prompt count (capped, not
 * dropped). `totalTokens` is left out unless the emitter sent one: `IngestService`
 * derives it from prompt + completion for every path.
 *
 * @returns The usage, or `undefined` when there is no prompt, completion or total count.
 */
function buildUsage(counts: UsageCounts): IngestSpan['usage'] {
  const { promptTokens, completionTokens, totalTokens, cachedTokens } = counts;
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined;
  const usage = UsageSchema.parse({ promptTokens, completionTokens, totalTokens, cachedTokens });
  // Drop keys that are `undefined` so the stored shape stays minimal.
  return Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== undefined));
}

/**
 * Token counts under the GenAI conventions. The older names (`prompt_tokens`,
 * `completion_tokens`) and OpenLLMetry's underscore cache name are read as fallbacks,
 * because instrumentors on older spec versions are still common.
 */
function genAiUsageCounts(attrs: Record<string, unknown>): UsageCounts {
  return {
    promptTokens: tokenAttr(attrs, 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens'),
    completionTokens: tokenAttr(attrs, 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens'),
    cachedTokens: tokenAttr(attrs, 'gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.cache_read_input_tokens'),
  };
}

/**
 * The `gen_ai.system` value Google ADK's legacy schema puts on its own spans. It names the
 * agent framework, not a model provider, so it is never stored as one.
 */
const ADK_SYSTEM = 'gcp.vertex.agent';

/**
 * The provider attribute when present, otherwise the provider the model name implies.
 * ADK's framework name is skipped as if it were absent, so a Gemini model still resolves.
 */
function providerOf(explicit: string | undefined, model: string | undefined): string | undefined {
  const named = explicit === ADK_SYSTEM ? undefined : explicit;
  return named ?? (model ? resolveProvider(model) ?? undefined : undefined);
}

/** The fields every mapper shares: identity, timing, status, payload and the stripped attributes. */
function baseSpan(raw: RawSpan, attrs: Record<string, unknown>): IngestSpan {
  return {
    spanId: raw.spanId,
    parentSpanId: raw.parentSpanId,
    name: raw.name,
    kind: 'other',
    status: mapStatus(raw.status),
    startTime: nanosToIso(raw.startTimeUnixNano),
    endTime: raw.endTimeUnixNano ? nanosToIso(raw.endTimeUnixNano) : undefined,
    input: resolveInput(attrs),
    output: resolveOutput(attrs),
    attributes: stripPayloadAttributes(attrs),
    error: raw.status?.code === 2 ? raw.status.message : undefined,
  };
}

/**
 * Maps one raw OTel span, tagged with the OpenInference attribute vocabulary, to an
 * `IngestSpan`. When a span also carries `gen_ai.*` keys (an OpenLLMetry span passed
 * through an OpenInference processor keeps both), the GenAI model and token counts fill
 * in what the OpenInference keys leave out.
 */
function mapOpenInferenceSpan(raw: RawSpan, attrs: Record<string, unknown>): IngestSpan {
  const genAi = genAiUsageCounts(attrs);
  const model = stringAttr(attrs, 'llm.model_name') ?? genAiModel(attrs);
  return {
    ...baseSpan(raw, attrs),
    kind: lookupKind(OPENINFERENCE_KIND_MAP, String(attrs['openinference.span.kind'])),
    model,
    provider: providerOf(stringAttr(attrs, 'llm.provider') ?? stringAttr(attrs, 'llm.system'), model),
    // No cost here: `IngestService` prices the span at ingest, where the team's own
    // model prices are known (team price first, built-in registry second).
    usage: buildUsage({
      promptTokens: tokenAttr(attrs, 'llm.token_count.prompt') ?? genAi.promptTokens,
      completionTokens: tokenAttr(attrs, 'llm.token_count.completion') ?? genAi.completionTokens,
      totalTokens: tokenAttr(attrs, 'llm.token_count.total'),
      // OpenInference's cache-read count, a subset of the prompt count. Prices the span (#594).
      cachedTokens: tokenAttr(attrs, 'llm.token_count.prompt_details.cache_read') ?? genAi.cachedTokens,
    }),
  };
}

/** The response model when present, since it names what actually ran; else the request model. */
function genAiModel(attrs: Record<string, unknown>): string | undefined {
  return stringAttr(attrs, 'gen_ai.response.model') ?? stringAttr(attrs, 'gen_ai.request.model');
}

/**
 * Span kinds whose GenAI token counts are an aggregate of their child llm spans. The spec
 * recommends `gen_ai.usage.*` on `invoke_agent` spans as the sum over the agent's own LLM
 * calls; pricing it too would count every token twice in the trace and session totals.
 */
const AGGREGATE_KINDS: ReadonlySet<SpanKind> = new Set(['agent', 'chain']);

/**
 * Tool span names in Google ADK's legacy schema: `execute_tool <name>` and
 * `execute_tool (merged)`, and in releases before 1.10, `tool_call [<name>]` and
 * `tool_response [<name>]` or a bare `tool_response`.
 */
const ADK_TOOL_SPAN_NAME = /^(execute_tool\b|tool_call \[|tool_response\b)/;

/**
 * The kind of a Google ADK legacy-schema span (`gen_ai.system=gcp.vertex.agent`) that has
 * no `gen_ai.operation.name`, read from the span name, since that is all ADK sets
 * (issue #773). `call_llm` is ADK's model call and the span that carries the request and
 * response; the tool names are listed in {@link ADK_TOOL_SPAN_NAME}.
 *
 * @returns The kind, or `undefined` when the span is not an ADK legacy span or its name
 *   is not one of these.
 */
function adkLegacyKind(raw: RawSpan, attrs: Record<string, unknown>): SpanKind | undefined {
  if (attrs['gen_ai.system'] !== ADK_SYSTEM || attrs['gen_ai.operation.name'] !== undefined) return undefined;
  if (raw.name === 'call_llm') return 'llm';
  if (ADK_TOOL_SPAN_NAME.test(raw.name)) return 'tool';
  return undefined;
}

/**
 * Maps a raw OTel span that uses the official OpenTelemetry GenAI semantic conventions
 * (`gen_ai.*`), as emitted by `opentelemetry-instrumentation-openai-v2` and OpenLLMetry, to
 * an `IngestSpan` (issue #757).
 *
 * A dated response model such as `gpt-4o-mini-2024-07-18` still prices, since the pricer
 * strips the date suffix. Agent and workflow spans keep their model but get no `usage`
 * (see {@link AGGREGATE_KINDS}); their counts stay visible in `attributes`. An embeddings
 * span reports only input tokens, so its completion count is set to 0 — the true value —
 * which lets it be priced and totalled like any other span.
 *
 * Google ADK's legacy `call_llm` span gets no `usage` either. Every ADK release since
 * 1.24.0 also emits a `generate_content` child span for the same model call with the same
 * counts, so pricing both would double the trace's tokens and cost. The counts stay in
 * `attributes`, as on an agent span.
 */
function mapGenAiSpan(raw: RawSpan, attrs: Record<string, unknown>): IngestSpan {
  const adkKind = adkLegacyKind(raw, attrs);
  const kind = adkKind ?? lookupKind(GEN_AI_OPERATION_KIND_MAP, stringAttr(attrs, 'gen_ai.operation.name'));
  const model = genAiModel(attrs);
  const counts = genAiUsageCounts(attrs);
  if (kind === 'embedding' && counts.promptTokens !== undefined && counts.completionTokens === undefined) {
    counts.completionTokens = 0;
  }
  return {
    ...baseSpan(raw, attrs),
    kind,
    model,
    provider: providerOf(stringAttr(attrs, 'gen_ai.provider.name') ?? stringAttr(attrs, 'gen_ai.system'), model),
    usage: AGGREGATE_KINDS.has(kind) || adkKind === 'llm' ? undefined : buildUsage(counts),
  };
}

/** True when any attribute uses the GenAI semantic-convention namespace. */
function isGenAiSpan(attrs: Record<string, unknown>): boolean {
  return Object.keys(attrs).some((key) => key.startsWith('gen_ai.'));
}

/**
 * A trailing run id that frameworks append to a root span's name, e.g. the
 * `_5f1fcf48-de64-42cf-b927-5c060836053` on CrewAI's `Crew_<uuid>`.
 *
 * Also matches a truncated uuid, because that is what CrewAI actually emits, and the
 * leading separator is optional so a name that is *nothing but* a run id trims to empty
 * and falls back — a bare uuid is no more findable in a trace list than a timestamp.
 */
/**
 * A uuid-shaped run id, matched anywhere in a span name rather than only at the end.
 * CrewAI emits `Crew_<uuid>.kickoff`, so the id sits mid-name; the last group is loose
 * because some emitters truncate it. Kept separate from the tidy-up below so each step
 * stays readable.
 */
const RUN_ID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){2}-[0-9a-f]{4}-?[0-9a-f]{0,12}/gi;

/** Two or more adjacent separators, left behind where a run id used to sit. */
const SEPARATOR_RUN = /[_.\s-]{2,}/g;

/** Separators stranded at either end once the run id in between is gone. */
const EDGE_SEPARATORS = /^[_.\s-]+|[_.\s-]+$/g;

/**
 * Removes a run id from a span name and tidies the punctuation it leaves behind.
 *
 * A separator run collapses to its **last** character so the surviving halves keep the
 * join the emitter meant: `Crew_<uuid>.kickoff` has `_` and `.` collide, and `.kickoff`
 * is the part that reads as a method call. Edge separators then go, so a trailing id
 * yields `Crew` rather than `Crew_`.
 *
 * @param name - A raw OTLP span name.
 * @returns The name with any run id and its orphaned punctuation removed. Empty when the
 *   name was nothing but a run id, which the caller reads as "no usable name".
 */
function stripRunId(name: string): string {
  return name
    .replace(RUN_ID, '')
    .replace(SEPARATOR_RUN, (run) => run.slice(-1))
    .replace(EDGE_SEPARATORS, '')
    .trim();
}

/**
 * Names a trace after its root span, which is the only name in an OTLP batch that
 * describes the whole run.
 *
 * Root means **no `parentSpanId` at all** — deliberately not "no parent in this batch".
 * OTLP arrives in batches, so a span whose parent is simply absent here is usually a
 * child whose parent flushed in an earlier export; naming the trace after it would name
 * the run after one of its leaves. A batch with no true root therefore contributes no
 * name and the timestamp fallback stands until the root turns up, which is honest: we do
 * not yet know what the run is called. With several roots the earliest wins, since a run
 * starts before anything it contains.
 *
 * The run id is trimmed wherever it sits: `Crew_5f1fcf48-….kickoff` reads worse than
 * `Crew.kickoff`, and — more usefully — two runs of the same crew then share a name,
 * which is what makes a name searchable at all. Without any of this every OTLP trace was named by its start
 * timestamp, so the trace list read as a wall of near-identical timestamps for exactly
 * the users who wrote no AcruxCore code: CrewAI, LangChain, LlamaIndex, the OpenAI Agents
 * SDK (issue #362).
 *
 * @param spans - Every span translated for one trace id.
 * @returns The trimmed root span name, or `undefined` when the batch holds no parentless
 *   span or its name trims to nothing (the caller's timestamp fallback then applies).
 */
function deriveTraceName(spans: IngestSpan[]): string | undefined {
  const roots = spans.filter((s) => !s.parentSpanId);
  if (roots.length === 0) return undefined;

  const root = roots.reduce((earliest, s) => (s.startTime < earliest.startTime ? s : earliest));
  const trimmed = root.name ? stripRunId(root.name) : undefined;
  return trimmed ? trimmed : undefined;
}

/**
 * Translates decoded OTLP `ResourceSpans` into AcruxCore's `IngestTrace[]` shape,
 * grouping spans by trace id. Two attribute vocabularies are understood: OpenInference
 * (`openinference.span.kind`, which wins when a span carries both) and the OpenTelemetry
 * GenAI semantic conventions (`gen_ai.*`). A span with neither lands as kind `other`.
 *
 * @param resourceSpans - Decoded OTLP resource/span groups (protobuf or JSON path).
 * @returns One `IngestTrace` per distinct trace id found across all resources, each named
 *   after its root span when the batch contains one.
 */
export function translateResourceSpans(resourceSpans: RawResourceSpans[]): IngestTrace[] {
  const byTraceId = new Map<string, IngestSpan[]>();
  const sessionByTraceId = new Map<string, string>();

  for (const rs of resourceSpans) {
    for (const raw of rs.spans) {
      const attrs = attributesToRecord(raw.attributes);
      const span =
        'openinference.span.kind' in attrs
          ? mapOpenInferenceSpan(raw, attrs)
          : isGenAiSpan(attrs)
            ? mapGenAiSpan(raw, attrs)
            : baseSpan(raw, attrs);

      const traceId = traceIdToUuid(raw.traceId);
      if (!byTraceId.has(traceId)) byTraceId.set(traceId, []);
      byTraceId.get(traceId)!.push(span);

      // OpenInference's `session.id`, or the GenAI conventions' `gen_ai.conversation.id`.
      const sessionId = stringAttr(attrs, 'session.id') ?? stringAttr(attrs, 'gen_ai.conversation.id');
      if (sessionId && !sessionByTraceId.has(traceId)) sessionByTraceId.set(traceId, sessionId);
    }
  }

  return Array.from(byTraceId.entries()).map(([traceId, spans]) => {
    const name = deriveTraceName(spans);
    return {
      traceId,
      sessionId: sessionByTraceId.get(traceId),
      ...(name ? { name } : {}),
      spans,
    };
  });
}
