// Type-only import: erased at compile time, so this does not create a runtime cycle
// with tools.ts (which imports acruxcoreError, whose only import from here is a type).
import type { AcruxTool, ZodLikeSchema } from './tools';

/** A single chat message. Content is null for an assistant turn that only calls tools. */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Present on assistant turns that call tools. */
  tool_calls?: ToolCall[];
  /** Present on `tool` messages — links a result to the assistant's call. */
  tool_call_id?: string;
}

/** A tool call emitted by the model. `arguments` is a JSON string. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** An OpenAI-shaped tool (function) definition. */
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

/** How the model should use tools. */
export type ToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

/**
 * Structured-output response format (OpenAI-shaped `response_format`), passed straight
 * through to the gateway. `'json_schema'` asks the model for a specific typed shape —
 * the gateway translates the format to each provider's native structured-output mode
 * (OpenAI/Gemini natively; Anthropic via a forced tool call under the hood, invisible to
 * the caller) and relies on the *provider* to honor it. The gateway does NOT validate the
 * model's returned content against `json_schema.schema` itself, so if schema conformance
 * is load-bearing, parse and validate the returned content on your side.
 *
 * Mutually exclusive with `tools`/`toolChoice`/`toolRefs` on the same gateway request —
 * the gateway rejects a request carrying both with a 400 `VALIDATION_ERROR`, whether the
 * tools are inline, resolved from `toolRefs`, or auto-attached from a stored prompt
 * version (the gateway re-checks after resolving all three, so there's no combination
 * that slips through). Pass both to {@link acruxcore.runToolLoop} and the SDK handles it
 * for you: it gathers with `tools` and no `responseFormat`, then makes one follow-up call
 * with `responseFormat` and no tools to shape the final typed answer, both on one trace.
 * Only `chat()` callers — who manage their own messages — must keep the two apart manually.
 */
export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; schema?: Record<string, unknown>; strict?: boolean } }
  | { zod: ZodLikeSchema<unknown>; name: string; strict?: boolean };

/** Result of renderPrompt: templated messages plus the version's attached tools. */
export interface RenderResult {
  messages: Message[];
  tools: ToolDefinition[];
  /**
   * The prompt version's bound default model (or null when none is set). Pass it
   * straight to {@link acruxcore.chat} / {@link acruxcore.runToolLoop} to run the
   * prompt on its bound model instead of hardcoding one.
   */
  model: string | null;
  /**
   * The resolved prompt version's id, or null if the server response omitted it
   * (defensive default; the render endpoint always includes it). Pass to
   * {@link acruxcore.chat} / {@link acruxcore.runToolLoop} as `promptVersionId` so a
   * client-reported trace (BYO or gateway) carries prompt lineage.
   */
  versionId: string | null;
  /** The resolved prompt version's number (matches versionId 1:1), or null. */
  versionNumber: number | null;
}

/**
 * BYO (bring-your-own-key) provider config. Present on a chat()/runToolLoop() call
 * (or the client's default) routes that call directly to `baseUrl` instead of our
 * gateway — the gateway hop and its network latency are skipped entirely, and
 * `apiKey` is sent only to `baseUrl`, never to us.
 */
export interface ProviderConfig {
  /** OpenAI-compatible base URL, e.g. "https://api.groq.com/openai/v1". */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <apiKey>` to `baseUrl` only. */
  apiKey: string;
}

/** Who authored a tool version. Mirrors the API's `ToolVersionSource` enum. */
export type ToolVersionSource = 'code' | 'dashboard' | 'api';

/** Outcome of one `POST /tools/sync` call. */
export interface ToolSyncResult {
  /** The catalog tool, created by the call if the name was new. */
  toolId: string;
  /** The version the alias points at after the call. */
  versionNumber: number;
  /** `false` when the submitted spec already matched the live one. */
  committed: boolean;
  alias: string;
  /**
   * `'dashboard'` when this commit replaced a dashboard-authored version — a hand edit
   * has stopped being live. Absent otherwise.
   */
  supersededSource?: ToolVersionSource;
}

/** One resolved catalog tool, from `POST /tools/resolve`. */
export interface ResolvedTool {
  /** The tool's id — what `tools.execute` needs. */
  toolId: string;
  /** The immutable version the ref's alias resolved to. */
  versionNumber: number;
  /** `'client'` (you run it) or `'http'` (the platform can). */
  executorType: 'client' | 'http';
  /** Ready to drop into an OpenAI-style `tools[].function`. */
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

/** Outcome of a server-side tool execution (`POST /tools/:id/execute`). */
export interface ToolExecuteResult {
  /** The tool's (possibly response-transformed) return value. */
  result: unknown;
  /** The upstream HTTP status the executor saw. */
  status: number;
  /** Server-measured wall-clock duration. */
  latencyMs: number;
  /** The version that actually ran. */
  toolVersionId: string;
}

// ── Prompts (PromptsNamespace, `hub.prompts`) ─────────────────────────────────

/** A single chat message in a prompt version's template. Content is a nunjucks template string. */
export interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** One catalog tool to attach when committing a version. Resolves by `alias` unless `pinnedVersionNumber` is given. */
export interface AttachToolInput {
  /** The catalog tool's id, from `hub.tools.resolve` or the dashboard. */
  toolId: string;
  /** Which of the tool's aliases to resolve at render time; server defaults to `production`. */
  alias?: string;
  /** Pin an exact tool version instead of following an alias. */
  pinnedVersionNumber?: number;
}

/** Shape of a prompt returned by `create`/`get`/`update`. */
export interface PromptDetail {
  id: string;
  name: string;
  description: string | null;
  teamId: string;
  createdBy: string;
  createdAt: string;
}

/** Shape of a prompt in {@link PromptListResult} — narrower than {@link PromptDetail} (no `teamId`/`createdBy`). */
export interface PromptListItem {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
}

/** Result of {@link PromptsNamespace.list} — a page of prompts. */
export interface PromptListResult {
  data: PromptListItem[];
  total: number;
  page: number;
  limit: number;
}

/** Body for {@link PromptsNamespace.create}. */
export interface CreatePromptInput {
  /** 1-255 chars, unique per team. */
  name: string;
  /** Up to 2000 chars. */
  description?: string;
}

/** Body for {@link PromptsNamespace.update}. At least one field must be set. */
export interface UpdatePromptInput {
  name?: string;
  /** Pass `null` to clear an existing description. */
  description?: string | null;
}

/** Query params for {@link PromptsNamespace.list}. All optional. */
export interface ListPromptsOptions {
  /** Free-text match against the prompt name. */
  search?: string;
  /** 1-based. */
  page?: number;
  limit?: number;
}

/** Body for {@link PromptsNamespace.commitVersion}. */
export interface CommitVersionInput {
  /** The version's full message list — versions are immutable, so this replaces, never patches. */
  messages: PromptMessage[];
  /** Catalog tools to attach to this version (max 64). */
  tools?: AttachToolInput[];
  /** Binds a default gateway model by its `publicName`; omit to leave the version unbound. */
  model?: string;
}

/** Shape of a version in {@link VersionListResult} — omits `messages`/`promptId` to keep list pages small. */
export interface VersionListItem {
  id: string;
  versionNumber: number;
  variables: string[];
  createdBy: string;
  createdAt: string;
  /** The bound default model's current `publicName`, or `null` if unbound. */
  model: string | null;
}

/** Result of {@link PromptsNamespace.listVersions} — a page of versions. */
export interface VersionListResult {
  data: VersionListItem[];
  total: number;
  page: number;
  limit: number;
}

/** Query params for {@link PromptsNamespace.listVersions}. All optional. */
export interface ListVersionsOptions {
  /** 1-based. */
  page?: number;
  limit?: number;
}

/**
 * Query params for {@link PromptsNamespace.tracesForVersion}. All optional.
 * Same shape as {@link ListVersionsOptions} but kept as its own named type since
 * the two paginate different resources (versions vs. traces).
 */
export interface PromptVersionTracesOptions {
  /** 1-based. */
  page?: number;
  limit?: number;
}

/** An alias pointing at one immutable version, from a promote or list call. */
export interface AliasDetail {
  id: string;
  alias: string;
  versionId: string;
  versionNumber: number;
  updatedAt: string;
}

/** Shape of a version from {@link PromptsNamespace.commitVersion} or {@link PromptsNamespace.getVersion}. */
export interface VersionDetail {
  id: string;
  promptId: string;
  versionNumber: number;
  /**
   * Looser than {@link CommitVersionInput.messages} (`PromptMessage[]`) on purpose:
   * `POST /prompts/import` validates a role as any non-empty string, not just
   * `'system'|'user'|'assistant'`, so an imported version's messages can legitimately
   * carry a role outside that set — matching the server's own `VersionDetail` DTO.
   */
  messages: Array<{ role: string; content: string }>;
  variables: string[];
  /** The bound default model's current `publicName`, or `null` if unbound. */
  model: string | null;
  createdBy: string;
  createdAt: string;
  /**
   * Every alias created alongside this version. Present ONLY when this is the
   * prompt's first version (both `production` and `staging` are minted and point
   * at it) — every later commit returns no `aliases` at all, since committing
   * never moves an alias by itself.
   */
  aliases?: AliasDetail[];
}

/** Result of {@link PromptsNamespace.diff} — a unified diff between two versions. */
export interface DiffResult {
  /** Unified diff string (as produced by the `diff` package's `createPatch`). */
  diff: string;
  fromVersion: number;
  toVersion: number;
}

/** The portable export format for a single prompt version (`schemaVersion` is always `1`). */
export interface ExportedPromptVersion {
  schemaVersion: 1;
  exportedAt: string;
  prompt: {
    name: string;
    description: string | null;
  };
  version: {
    versionNumber: number;
    messages: Array<{ role: string; content: string }>;
    variables: string[];
    createdAt: string;
  };
}

/**
 * Body for {@link PromptsNamespace.importPrompt} — matches the API's `ImportBodySchema`.
 * `version.messages` items are `{ role: string; content: string }`, looser than
 * {@link PromptMessage}, since the API itself only requires non-empty strings there.
 */
export interface ImportPromptInput {
  schemaVersion: 1;
  exportedAt?: string;
  prompt: {
    name: string;
    description?: string | null;
  };
  version: {
    versionNumber?: number;
    messages: Array<{ role: string; content: string }>;
    variables?: string[];
    createdAt?: string;
  };
}

/**
 * Result of {@link PromptsNamespace.importPrompt}. `prompt.name` may differ from
 * the input on a name collision — the server appends `-imported-<unix_ms>` rather
 * than rejecting the import.
 */
export interface ImportPromptResult {
  prompt: { id: string; name: string };
  version: { id: string; versionNumber: number };
}

/** A catalog tool's mutable shell — the shared shape for `create`/`get`/`update`/`list` items. */
export interface ToolDetail {
  id: string;
  name: string;
  description: string | null;
  teamId: string;
  createdBy: string;
  createdAt: string;
}

/** Result of {@link ToolsNamespace.list} — a page of tools. */
export interface ToolListResult {
  data: ToolDetail[];
  total: number;
  page: number;
  limit: number;
}

/** Input to {@link ToolsNamespace.create}. */
export interface CreateToolInput {
  /** Must match `^[a-zA-Z0-9_-]{1,64}$` — the function name the model sees. */
  name: string;
  description?: string;
}

/** Input to {@link ToolsNamespace.update}. At least one field is required by the API. */
export interface UpdateToolInput {
  name?: string;
  /** Pass `null` to clear an existing description; omit to leave it untouched. */
  description?: string | null;
}

/** Query params for {@link ToolsNamespace.list}. All optional. */
export interface ListToolsOptions {
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * A tool version's executor, as a discriminated union on `type`. `'client'` means the
 * caller's own app runs the tool; `'http'` means the platform can call it directly.
 */
export type ToolExecutor =
  | { type: 'client' }
  | {
      type: 'http';
      url: string;
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      headers: { name: string; value: string }[];
      query: { name: string; value: string }[];
      bodyTemplate?: string;
      argMapping: { arg: string; in: 'query' | 'path' | 'header' | 'body'; path?: string }[];
      requestTransform?: string;
      responseTransform?: string;
    };

/** Input to {@link ToolsNamespace.commitVersion}. */
export interface CommitToolVersionInput {
  description?: string;
  changelog?: string;
  /**
   * Defaults server-side to `'api'`. `'code'` is rejected here — only `tools.sync`
   * (`POST /tools/sync`) may write it, since that value means "derived from a
   * decorated function" and a hand-rolled commit must not be able to forge it.
   */
  source?: 'dashboard' | 'api';
  parametersSchema: Record<string, unknown>;
  executor: ToolExecutor;
}

/** A committed tool version, as returned by {@link ToolsNamespace.commitVersion}/{@link ToolsNamespace.getVersion}. */
export interface ToolVersionDetail {
  id: string;
  toolId: string;
  versionNumber: number;
  description: string | null;
  /** Release note for humans. Never read by the resolver, so never seen by the model. */
  changelog: string | null;
  source: ToolVersionSource;
  parametersSchema: unknown;
  executor: ToolExecutor;
  createdBy: string;
  createdAt: string;
  /**
   * Present ONLY on the tool's first version — both `production` and `staging` are
   * minted and point at it. Every later commit returns no `aliases` at all, and
   * {@link ToolsNamespace.getVersion} never includes it either way.
   */
  aliases?: ToolAliasDetail[];
  /** Present only when this commit has a `changelog` but no `description`. */
  warnings?: string[];
}

/** A tool version in {@link ToolsNamespace.listVersions}'s page — omits `parametersSchema`/`executor`. */
export interface ToolVersionListItem {
  id: string;
  toolId: string;
  versionNumber: number;
  description: string | null;
  changelog: string | null;
  source: ToolVersionSource;
  createdBy: string;
  createdAt: string;
}

/** Result of {@link ToolsNamespace.listVersions} — a page of a tool's versions, newest first. */
export interface ToolVersionListResult {
  data: ToolVersionListItem[];
  total: number;
  page: number;
  limit: number;
}

/** Query params for {@link ToolsNamespace.listVersions}. All optional. */
export interface ListToolVersionsOptions {
  page?: number;
  limit?: number;
}

/** A tool alias's resolved state, as returned by {@link ToolsNamespace.promoteAlias}. */
export interface ToolAliasDetail {
  id: string;
  alias: string;
  versionId: string;
  versionNumber: number;
  updatedAt: string;
}

/** Query params for {@link ToolsNamespace.analytics}. Both bounds are optional ISO-8601 datetimes. */
export interface ToolAnalyticsOptions {
  since?: string;
  until?: string;
}

/** Aggregated call stats for one tool over the requested window. */
export interface ToolStat {
  toolName: string;
  calls: number;
  /** 0..1. */
  errorRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** Result of {@link ToolsNamespace.analytics} — one entry per tool that had calls in the window. */
export interface ToolAnalyticsResult {
  data: ToolStat[];
}

/** Trace options shared by `chat()` and `runToolLoop()`. */
export interface TraceOptions {
  traceId?: string;
  sessionId?: string;
  name?: string;
  /** Tags attached to the trace. Union-merged on append. */
  tags?: string[];
  /** JSON metadata attached to the trace. Shallow-merged on append. */
  metadata?: Record<string, unknown>;
}

/** Options for runToolLoop. */
export interface RunToolLoopOptions {
  model: string;
  messages: Message[];
  /**
   * Tools declared with `acrux.tool`. Reconciled with the catalog, then run locally.
   *
   * `AcruxTool<never>` rather than a wildcard: a handler taking `{ city: string }` is
   * assignable to one taking `never` (parameter contravariance), so any declared tool
   * fits here while the array itself stays type-safe.
   */
  tools?: AcruxTool<never>[];
  /** Raw OpenAI-shaped definitions, sent inline. These always route to `dispatch`. */
  toolDefs?: ToolDefinition[];
  /** Catalog references. An `http` executor runs on the platform; a `client` one needs a runner. */
  toolRefs?: { name: string; alias?: string }[];
  /**
   * Runs one tool call the app implements itself. Needed only for `toolDefs` and for
   * `client` refs with no matching `tools` entry.
   */
  dispatch?: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
  /**
   * Reconcile `tools` with the catalog before the first model call. Default `true`.
   * Pass `false` when a deploy step already synced them and the loop should make no
   * catalog writes.
   */
  sync?: boolean;
  /** Max round-trips before stopping (default 10). */
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  /**
   * Structured-output format for the loop's final answer. May be combined with
   * `tools`/`toolDefs`/`toolRefs`: when it is, the SDK runs the tool-gathering loop
   * with the format stripped, then one follow-up call with `responseFormat` set and
   * no tools to shape the typed answer — both on one trace (see
   * {@link ResponseFormat} for why the gateway cannot take both on one request).
   */
  responseFormat?: ResponseFormat;
  /**
   * Auto-report an `llm` span per model round-trip plus a `tool` span per
   * `dispatch` call, batched into one trace via {@link acruxcore.trace} once the
   * loop ends. Default `true`. Pass `false` to disable, or `{ traceId }` to
   * append to a trace you already have instead of minting a new one.
   */
  trace?: boolean | TraceOptions;
  /** Per-call BYO override; wins over the client's config.provider. */
  provider?: ProviderConfig;
  /** From renderPrompt().versionId; stamped on every llm span this loop records. */
  promptVersionId?: string;
}

/** Result of runToolLoop: the final assistant text + the full transcript + iteration count. */
export interface RunToolLoopResult {
  content: string;
  messages: Message[];
  iterations: number;
  stoppedAtLimit: boolean;
  /** The trace id spans were reported under, or undefined when `trace: false`. */
  traceId?: string;
}

/** Response metadata the gateway stamps on every `/gateway/chat/completions` call. */
export interface GatewayCallMeta {
  requestId: string | null;
  provider: string | null;
  model: string | null;
  /** Parsed from `x-gateway-cost-usd`; null when absent (e.g. streaming, unpriced model). */
  costUsd: number | null;
  cache: string | null;
  /**
   * The trace this call's `llm` span landed in (from `x-gateway-trace-id`), or null
   * when the gateway recorded no span. `runToolLoop` reuses this to keep every
   * round-trip in one trace.
   */
  traceId: string | null;
  /**
   * The opaque ref of the `llm` span the gateway recorded (from `x-gateway-span-id`),
   * or null. `runToolLoop` uses it to nest each round's `tool` spans under it.
   */
  spanRef: string | null;
}

/** Token usage as returned by the gateway's OpenAI-shaped `usage` object. */
export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Options for {@link acruxcore.chat} — a single, non-looping gateway completion call. */
export interface ChatOptions {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  toolRefs?: { name: string; alias?: string }[];
  toolChoice?: ToolChoice;
  /** Structured-output format. Mutually exclusive with `tools`/`toolChoice` — see {@link ResponseFormat}. */
  responseFormat?: ResponseFormat;
  temperature?: number;
  maxTokens?: number;
  /** When true, `chat()` returns an async iterable of {@link ChatChunk} instead of a {@link ChatResult}. */
  stream?: boolean;
  /** Per-call BYO override; wins over the client's config.provider. */
  provider?: ProviderConfig;
  /** From renderPrompt().versionId; stamped on the llm span for lineage. */
  promptVersionId?: string;
  /**
   * Auto-report a trace for this call. Default `true` when `provider` is set
   * (nothing else will trace a BYO call); default `false` otherwise (unchanged —
   * the gateway already records its own trace for every completion). Pass
   * `{ traceId, sessionId? }` instead of a bare `true` to append this call to a
   * trace/session from an earlier call — e.g. several manual chat() calls that
   * make up one application-level "turn".
   */
  trace?: boolean | TraceOptions;
}

/** Result of a non-streaming {@link acruxcore.chat} call. */
export interface ChatResult {
  id: string;
  model: string;
  /** The assistant's text content; null when the turn only calls tools. */
  content: string | null;
  /** The full assistant message, including any `tool_calls` (never auto-dispatched). */
  message: Message;
  finishReason: string | null;
  usage?: ChatUsage;
  /** Metadata from the gateway's `x-gateway-*` response headers. */
  gateway: GatewayCallMeta;
}

/** One SSE chunk from a streaming {@link acruxcore.chat} call. */
export interface ChatChunk {
  id: string;
  model: string;
  delta: { role?: string; content?: string };
  finishReason: string | null;
}

/** Input to {@link acruxcore.submitFeedback}. At least one of rating/label/comment is required. */
export interface FeedbackInput {
  traceId: string;
  /** Attaches to one span instead of the whole trace; omit for whole-trace feedback. */
  spanId?: string;
  /** -1..5. */
  rating?: number;
  label?: string;
  comment?: string;
  source?: 'user' | 'developer' | 'end_user' | 'api';
}

/** Input to {@link acruxcore.updateFeedback}. Omitted fields keep their existing value. */
export interface FeedbackUpdateInput {
  traceId: string;
  feedbackId: string;
  rating?: number | null;
  label?: string | null;
  comment?: string | null;
}

/** A feedback row as returned by the traces feedback endpoints. */
export interface FeedbackResult {
  id: string;
  traceId: string;
  spanId: string | null;
  rating: number | null;
  label: string | null;
  comment: string | null;
  source: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Trace header, as returned by `GET /traces/:id` and `GET /traces`. */
export interface TraceSummary {
  id: string;
  name: string | null;
  sessionId: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  spanCount: number;
  totalCostUsd: number | null;
  totalTokens: number | null;
  durationMs?: number;
}

/** One span in the tree returned by `GET /traces/:id`, nested via `children`. */
export interface TraceSpan {
  spanId: string;
  parentSpanId: string | null;
  kind: SpanKind;
  name: string;
  status: SpanStatus;
  startedAt: string;
  endedAt: string | null;
  latencyMs: number | null;
  model: string | null;
  provider: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  promptVersionId: string | null;
  gatewayRequestId: string | null;
  errorMessage: string | null;
  attributes: Record<string, unknown>;
  tags: string[];
  metadata: Record<string, unknown>;
  payload?: { input?: unknown; output?: unknown };
  children: TraceSpan[];
}

/** Result of {@link acruxcore.getTrace} — the trace header plus its span tree. */
export interface GetTraceResult {
  trace: TraceSummary;
  spans: TraceSpan[];
}

/** Result of {@link acruxcore.listTraces} — a page of trace summaries. */
export interface ListTracesResult {
  data: TraceSummary[];
  total: number;
  page: number;
  limit: number;
}

/** Query params for {@link acruxcore.listTraces}. All optional. */
export interface ListTracesOptions {
  from?: string;
  to?: string;
  status?: SpanStatus;
  model?: string;
  sessionId?: string;
  promptVersionId?: string;
  minLatencyMs?: number;
  minCostUsd?: number;
  minTokens?: number;
  q?: string;
  page?: number;
  limit?: number;
}

/**
 * Configuration for the acruxcore client.
 * All fields are optional; constructor falls back to environment variables,
 * then to built-in defaults. `apiKey` and `baseUrl` throw if neither is provided.
 */
export interface acruxcoreConfig {
  /** API key for authentication. Fallback: process.env.ACRUXCORE_API_KEY */
  apiKey?: string;
  /** Base URL of the acruxcore API. Fallback: process.env.ACRUXCORE_BASE_URL */
  baseUrl?: string;
  /**
   * How long a rendered prompt stays fresh, in milliseconds. Default: 60_000 (60 seconds).
   * Renders are cached per (api key, prompt, alias, variables). Set to `0` to disable
   * caching entirely — every `renderPrompt` call then goes to the API.
   */
  cacheTtl?: number;
  /** Maximum number of LRU cache entries. Default: 500. Set by the first constructor call. */
  maxCacheSize?: number;
  /** Number of retries on transient failure. Default: 1 (2 total attempts). */
  maxRetries?: number;
  /** Milliseconds to wait between retries. Default: 500. */
  retryInterval?: number;
  /** Client-level BYO default. A per-call `provider` on chat()/runToolLoop() overrides this. */
  provider?: ProviderConfig;
}

/**
 * Machine-readable error codes thrown by acruxcore operations.
 * Use `instanceof acruxcoreError` + `error.code` for programmatic handling.
 */
export type acruxcoreErrorCode =
  | 'MISSING_API_KEY'    // Constructor: no apiKey in args or env
  | 'MISSING_BASE_URL'   // Constructor: no baseUrl in args or env
  | 'NETWORK_ERROR'      // All retries exhausted (network-level failure)
  | 'API_ERROR'          // Non-retryable HTTP error (4xx, or 5xx after retries)
  | 'MISSING_VARIABLES'  // 400: template has variables not supplied by caller
  | 'TOOL_SCHEMA_ERROR'  // tool(): parameters are neither a zod schema nor a JSON Schema object
  | 'MISSING_DISPATCH'   // runToolLoop: a tool has no implementation to run
  | 'ZOD_NOT_AVAILABLE'  // A zod schema was given but zod could not be imported
  | 'PROVIDER_ERROR';    // BYO: non-2xx response from the caller's own provider endpoint

/** What a reported span represents. Mirrors the API's `span_kind` enum. */
export type SpanKind = 'llm' | 'tool' | 'retrieval' | 'embedding' | 'agent' | 'chain' | 'other';

/** Terminal status of a reported span. Mirrors the API's `span_status` enum. */
export type SpanStatus = 'ok' | 'error' | 'unset';

/**
 * One OTel-shaped span to report via {@link acruxcore.trace}. `spanId` is a
 * caller-chosen opaque id, unique within its trace; `parentSpanId` links to
 * another span's `spanId`. `input`/`output` are stored only if the team (or this
 * request) has payload capture enabled.
 */
export interface IngestSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: SpanKind;
  status?: SpanStatus;
  /** ISO-8601 datetime with a timezone offset (or `Z`). */
  startTime: string;
  /** ISO-8601 datetime; if present must be >= startTime. */
  endTime?: string;
  model?: string;
  provider?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  costUsd?: number;
  promptVersionId?: string;
  input?: unknown;
  output?: unknown;
  attributes?: Record<string, unknown>;
  error?: string;
}

/**
 * Input to {@link acruxcore.trace}. Omit `traceId` to mint a new trace; supply a
 * traceId returned by a previous call (or minted by the gateway) to append.
 * `tags`/`metadata` are set on creation; appending to an existing trace merges
 * them (union tags, shallow-merge metadata) rather than overwriting.
 */
export interface TraceInput {
  traceId?: string;
  sessionId?: string;
  name?: string;
  /** Per-trace override to force payload capture on, regardless of the team default. */
  capturePayloads?: boolean;
  tags?: string[];
  metadata?: Record<string, unknown>;
  spans: IngestSpan[];
}

/** Result of {@link acruxcore.trace} — the resolved trace id. */
export interface TraceResult {
  traceId: string;
}

/** Options for {@link TracesNamespace.analytics}. All optional; window defaults to the last 30 days. */
export interface AnalyticsOptions {
  /** ISO date/datetime — inclusive lower bound on `startedAt`. */
  from?: string;
  /** ISO date/datetime — exclusive upper bound on `startedAt`. */
  to?: string;
  /** Aggregation dimension. Defaults server-side to `'day'`. */
  groupBy?: 'day' | 'model' | 'session' | 'prompt_version';
  /** Narrows to spans of one kind. */
  kind?: SpanKind;
  /** Narrows to spans reported with this exact model string. */
  model?: string;
}

/** p50/p95/p99 latency in milliseconds. Each is `null` when the group has no timed spans. */
export interface LatencyPercentiles {
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/** Aggregate metrics shared by the range-wide totals and each grouped bucket. */
export interface AnalyticsTotals {
  requests: number;
  /** Fraction (0..1) of spans with `status: 'error'` — NOT a percentage. */
  errorRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Null-cost spans sum as 0, so this is never null itself. */
  costUsd: number;
  latencyMs: LatencyPercentiles;
}

/** One grouped bucket — `key` is a day string, model name, session id, or prompt-version label. */
export interface AnalyticsBucket extends AnalyticsTotals {
  key: string;
}

/** Result of {@link TracesNamespace.analytics}. */
export interface AnalyticsResult {
  /** Resolved window start, `YYYY-MM-DD`. */
  from: string;
  /** Resolved window end, `YYYY-MM-DD`. */
  to: string;
  groupBy: 'day' | 'model' | 'session' | 'prompt_version';
  totals: AnalyticsTotals;
  /**
   * One entry per distinct group key that occurred in the window. A bucket whose
   * group key is null (e.g. a span with no model) is omitted here entirely, even
   * though it is still counted in `totals`.
   */
  buckets: AnalyticsBucket[];
}

/** Result of {@link TracesNamespace.listFacets} — the team's distinct tags and metadata keys. */
export interface TraceFacets {
  tags: string[];
  metadataKeys: string[];
}

/** Result of {@link TracesNamespace.getFacetValues} — the team's distinct values for one metadata key. */
export interface FacetValuesResult {
  values: string[];
}

/** Result of {@link TracesNamespace.getSettings} / {@link TracesNamespace.updateSettings}. */
export interface TraceSettings {
  capturePayloads: boolean;
  /** Null until the team's settings row has ever been written (lazy default). */
  updatedAt: string | null;
}

/** Options for {@link TracesNamespace.getFeedbackSummary}. All optional; window defaults to the last 30 days. */
export interface FeedbackSummaryOptions {
  /** ISO date/datetime — inclusive lower bound. */
  from?: string;
  /** ISO date/datetime — exclusive upper bound. */
  to?: string;
  /** Aggregation dimension. Defaults server-side to `'prompt_version'`. */
  groupBy?: 'prompt_version' | 'model';
}

/** One grouped bucket in {@link FeedbackSummaryResult}. */
export interface FeedbackBucket {
  key: string;
  count: number;
  /** Mean of non-null ratings in the bucket; null when the bucket has no ratings. */
  avgRating: number | null;
  /** Count of feedback rows with `rating < 0` (thumbs-down). */
  downCount: number;
}

/**
 * Result of {@link TracesNamespace.getFeedbackSummary}. A group key with no
 * feedback yet is simply absent from `buckets`, never a zeroed entry.
 */
export interface FeedbackSummaryResult {
  groupBy: 'prompt_version' | 'model';
  buckets: FeedbackBucket[];
}

/** Options for {@link TracesNamespace.listFeedback}. */
export interface ListFeedbackOptions {
  page?: number;
  /** Capped at 100 server-side. */
  limit?: number;
}

/** Result of {@link TracesNamespace.listFeedback} — team-wide, newest-first, paginated. */
export interface FeedbackListResult {
  data: FeedbackResult[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Result of {@link TracesNamespace.getTraceFeedback} — every feedback row for one
 * trace. Unlike {@link FeedbackListResult}, this envelope carries no `total`/`page`/
 * `limit`: it is a full, unpaginated list scoped to a single trace.
 */
export interface TraceFeedbackResult {
  data: FeedbackResult[];
}

/**
 * One rolled-up session — a distinct `sessionId` for the team, with its trace
 * count, summed cost/tokens, and activity time span.
 */
export interface SessionSummary {
  sessionId: string;
  traceCount: number;
  /** Null when none of the session's traces carried a cost. */
  totalCostUsd: number | null;
  totalTokens: number;
  /** ISO — earliest `startedAt` among the session's traces. */
  firstAt: string;
  /** ISO — latest `startedAt` among the session's traces. */
  lastAt: string;
}

/**
 * One trace inside a session, as returned nested in {@link SessionDetailResult}.
 * Deliberately NOT {@link TraceSummary}: this shape additionally carries `tags`,
 * which `TraceSummary` (from `GET /traces`/`GET /traces/:id`) does not have.
 */
export interface SessionTraceItem {
  id: string;
  name: string | null;
  sessionId: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  spanCount: number;
  totalCostUsd: number | null;
  totalTokens: number;
  tags: string[];
}

/** Options for {@link SessionsNamespace.list}. All optional; window defaults to the last 30 days. */
export interface SessionListOptions {
  /** ISO date/datetime — inclusive lower bound on trace activity. */
  from?: string;
  /** ISO date/datetime — exclusive upper bound on trace activity. */
  to?: string;
  page?: number;
  /** Capped at 100 server-side; default 20. */
  limit?: number;
  /** Case-insensitive substring match on the session id. */
  q?: string;
}

/** Result of {@link SessionsNamespace.list} — paginated, one entry per session. */
export interface SessionListResult {
  data: SessionSummary[];
  total: number;
  page: number;
  limit: number;
}

/** Result of {@link SessionsNamespace.get} — one session's summary plus its traces. */
export interface SessionDetailResult {
  session: SessionSummary;
  traces: SessionTraceItem[];
}
