import type {
  Message,
  acruxcoreConfig,
  TraceInput,
  TraceResult,
  RenderResult,
  ToolDefinition,
  RunToolLoopOptions,
  RunToolLoopResult,
  ChatOptions,
  ChatResult,
  ChatChunk,
  ChatUsage,
  ToolCall,
  GatewayCallMeta,
  IngestSpan,
  FeedbackInput,
  FeedbackUpdateInput,
  FeedbackResult,
  GetTraceResult,
  ListTracesOptions,
  ListTracesResult,
  ResolvedTool,
  ProviderConfig,
  ResponseFormat,
} from './types';
import { createHash, randomUUID } from 'node:crypto';
import { acruxcoreError } from './error';
import { getCache } from './cache';
import { fetchWithRetry } from './fetch';
import { type AcruxTool, isAcruxTool, parseToolArgs, resolveParametersSchema } from './tools';
import { ToolsNamespace } from './tools-api';
import { inferProviderName } from './provider';
import { resolveResponseFormat } from './responseFormat';
import { SpanQueue } from './span-queue';

const DEFAULT_CACHE_TTL = 60_000;
const DEFAULT_MAX_CACHE_SIZE = 500;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_INTERVAL = 500;

/**
 * Hashes an API key for use in a cache key (Finding #20) — never store the raw
 * key verbatim, since any future debug logging of cache keys (or a heap/core
 * dump) would otherwise leak it. Truncated to 16 hex chars: this only needs to
 * disambiguate keys from each other, not resist offline brute-force (an
 * attacker who can already read process memory has the raw key anyway).
 *
 * @param apiKey - The raw API key.
 * @returns A 16-hex-character, deterministic-per-key digest.
 */
function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

/**
 * Serialises a value with object keys in sorted order, at every depth, so that
 * two variable maps that differ only in insertion order produce one string.
 * `JSON.stringify` preserves insertion order, which would otherwise split
 * `{ a, b }` and `{ b, a }` into two cache entries for the same render.
 *
 * @param value - Any JSON-serialisable value (undefined serialises to `null`).
 * @returns A canonical string form of the value.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * Fingerprints the variables a render was performed with, so they can take part
 * in the cache key. Without this, a second render of the same prompt with
 * different variables is served the first render's output.
 *
 * @param variables - The template variables passed to the render endpoint.
 * @returns A 16-hex-character digest, stable across key insertion order.
 */
function hashVariables(variables: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(variables)).digest('hex').slice(0, 16);
}

/**
 * True for a loopback host (`localhost`, `127.0.0.1`, `::1`) — legitimate to
 * reach over plain HTTP during local development.
 *
 * @param hostname - The URL's hostname (no port, no brackets for IPv6).
 * @returns Whether this host is a loopback address.
 */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/**
 * URLs already warned about, so the check can run per call (the BYO provider path
 * runs once per completion — and once per round inside `runToolLoop`) while still
 * logging at most one line per distinct URL instead of flooding stderr.
 */
const warnedCleartextUrls = new Set<string>();

/**
 * Warns, once per URL, when an Authorization-bearing request is about to travel
 * over cleartext HTTP to a non-loopback host (Finding #21, extended to BYO
 * provider URLs by the final whole-branch review's M7 — the BYO path sends the
 * caller's *provider* key as a Bearer token to a caller-supplied URL, so it needs
 * the same guard the platform `baseUrl` already had).
 *
 * A warning, not a hard error, so legitimate local-dev `http://localhost:11434`
 * (Ollama and friends) usage keeps working unprompted.
 *
 * @param url - The base URL about to receive a Bearer token.
 * @param what - How to name it in the message (e.g. `baseUrl`, `provider.baseUrl`).
 */
function warnIfCleartextUrl(url: string, what: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || isLoopbackHost(parsed.hostname)) return;
    const key = `${what}:${url}`;
    if (warnedCleartextUrls.has(key)) return;
    warnedCleartextUrls.add(key);
    console.warn(
      `acruxcore: ${what} "${url}" is not HTTPS — the API key and request/response bodies sent to it will travel in cleartext. Use an https:// URL outside local development.`,
    );
  } catch {
    // An unparseable URL is the caller's problem to discover from the request
    // itself failing — not something to warn (or throw) about here.
  }
}

/**
 * Live clients that may still have spans to send, held weakly so an abandoned client
 * can still be collected.
 *
 * One shared `beforeExit` listener serves all of them. A listener per client would trip
 * Node's default max-listeners warning at eleven clients, and it would hold the client
 * just as strongly through its own closure.
 */
const clientsAwaitingExitFlush = new Set<WeakRef<acruxcore>>();

/** The attached `beforeExit` listener, or undefined when none is attached. */
let beforeExitListener: (() => void) | undefined;

/** Detaches the shared `beforeExit` listener, if one is attached. */
function detachExitListener(): void {
  if (beforeExitListener && typeof process !== 'undefined') {
    process.removeListener('beforeExit', beforeExitListener);
    beforeExitListener = undefined;
  }
}

/**
 * Enrols a client in the shared exit flush, attaching the listener on first use.
 *
 * `beforeExit` fires when a script finishes its work and the event loop drains — the
 * shape of every one-shot CLI and of every guide we publish. Deliberately NOT
 * `SIGINT`/`SIGTERM`: registering a listener for those suppresses Node's default
 * terminate behaviour, so an SDK doing it would silently break Ctrl-C in the consuming
 * application. A long-running server calls `close()` in the shutdown path it already has.
 *
 * @param ref - Weak reference to the client to flush at exit.
 */
function registerExitFlush(ref: WeakRef<acruxcore>): void {
  if (typeof process === 'undefined' || typeof process.on !== 'function') return;
  clientsAwaitingExitFlush.add(ref);
  if (beforeExitListener) return;
  beforeExitListener = () => {
    // Detached as it fires: the flushes below are async work on an event loop that was
    // about to drain, so leaving it attached would let `beforeExit` re-arm in a loop.
    detachExitListener();
    for (const candidate of clientsAwaitingExitFlush) {
      const client = candidate.deref();
      if (client) void client.flush();
      else clientsAwaitingExitFlush.delete(candidate);
    }
  };
  process.on('beforeExit', beforeExitListener);
}

/**
 * Removes a client from the shared exit flush, detaching the listener once none are left.
 *
 * @param ref - The same weak reference passed to {@link registerExitFlush}.
 */
function unregisterExitFlush(ref: WeakRef<acruxcore>): void {
  clientsAwaitingExitFlush.delete(ref);
  if (clientsAwaitingExitFlush.size === 0) detachExitListener();
}

/**
 * How one tool name gets executed during a loop.
 *
 * Resolved once before the first model call, so a missing `dispatch` is a startup error
 * rather than something discovered mid-conversation after tokens were spent.
 */
interface ToolRoute {
  /** `'local'` (a declared tool), `'http'` (the platform runs it) or `'dispatch'`. */
  kind: 'local' | 'http' | 'dispatch';
  /** The declared tool, for `'local'`. */
  tool?: AcruxTool<never>;
  /** The catalog id, for `'http'` — what `execute` posts to. */
  toolId?: string;
  /** The alias this route resolved through. */
  alias?: string;
  /** `"<toolId>:<versionNumber>"`, recorded on the tool span so a trace can say which version ran. */
  toolVersionId?: string;
}

/**
 * Client for fetching rendered prompts from acruxcore.
 *
 * Create one instance at process startup and reuse it — the cache is a
 * module-level singleton and `maxCacheSize` is set by the first constructor call.
 *
 * @example
 * ```typescript
 * const hub = new acruxcore({ apiKey: process.env.ACRUXCORE_API_KEY, baseUrl: process.env.ACRUXCORE_BASE_URL });
 * const { messages, tools } = await hub.renderPrompt('my-prompt', 'production', { name: 'Alice' });
 * ```
 */
export class acruxcore {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly cacheTtl: number;
  private readonly maxRetries: number;
  private readonly retryInterval: number;
  private readonly providerDefault?: ProviderConfig;
  /**
   * Buffer the internal auto-reports drain through, so a model call never waits on
   * telemetry. The public `trace()` does not use it — callers await that one for its
   * returned `traceId`.
   */
  private readonly spanQueue: SpanQueue;
  /** This client's entry in the shared exit-flush registry. */
  private readonly exitRef: WeakRef<acruxcore> = new WeakRef(this);

  /** Catalog operations — see {@link ToolsNamespace}. */
  public readonly tools: ToolsNamespace;

  /**
   * Initialises the acruxcore client. Throws immediately on missing required config.
   *
   * Config resolution order for each field: constructor arg → environment variable → default.
   *
   * @param config - Optional configuration overrides.
   * @throws {acruxcoreError} MISSING_API_KEY if no apiKey is provided and ACRUXCORE_API_KEY is unset.
   * @throws {acruxcoreError} MISSING_BASE_URL if no baseUrl is provided and ACRUXCORE_BASE_URL is unset.
   */
  constructor(config?: acruxcoreConfig) {
    const apiKey = config?.apiKey ?? process.env.ACRUXCORE_API_KEY;
    if (!apiKey) {
      throw new acruxcoreError(
        'acruxcore: apiKey is required. Pass it in the constructor or set ACRUXCORE_API_KEY.',
        'MISSING_API_KEY',
      );
    }

    const baseUrl = config?.baseUrl ?? process.env.ACRUXCORE_BASE_URL;
    if (!baseUrl) {
      throw new acruxcoreError(
        'acruxcore: baseUrl is required. Pass it in the constructor or set ACRUXCORE_BASE_URL.',
        'MISSING_BASE_URL',
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.cacheTtl = config?.cacheTtl ?? DEFAULT_CACHE_TTL;
    this.maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryInterval = config?.retryInterval ?? DEFAULT_RETRY_INTERVAL;
    this.providerDefault = config?.provider;

    getCache(config?.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE);

    // Finding #21: a misconfigured baseUrl env var would otherwise silently
    // send the Authorization header (and every request body) in cleartext.
    warnIfCleartextUrl(this.baseUrl, 'baseUrl');
    // A client-level BYO provider default gets the same check up front; a
    // per-call `options.provider` is checked when the call is actually made.
    if (this.providerDefault?.baseUrl) {
      warnIfCleartextUrl(this.providerDefault.baseUrl, 'provider.baseUrl');
    }

    this.tools = new ToolsNamespace(this);

    this.spanQueue = new SpanQueue((batch) => this._sendTraceBatch(batch));
    registerExitFlush(this.exitRef);
  }

  /**
   * Short, non-reversible fingerprint of this client's key, for cache keys.
   *
   * @internal Used by {@link ToolsNamespace} to keep two clients pointed at different
   *   teams from sharing a sync-cache entry.
   * @returns A 16-hex-character digest.
   */
  _apiKeyFingerprint(): string {
    return hashApiKey(this.apiKey);
  }

  /**
   * Renders a stored prompt by name + alias and returns its templated messages plus
   * the version's attached tools (OpenAI-shaped). Cached per (name, alias, variables).
   *
   * - On cache hit (fresh): returns cached value immediately, no network call.
   * - On cache hit (stale): returns cached value immediately, fires background refresh.
   * - On cache miss: fetches from API, caches result, returns it.
   * - API unreachable + stale entry: returns stale value, logs warning.
   * - API unreachable + cold cache: throws NETWORK_ERROR after retries.
   *
   * The cache key covers the variables, so rendering the same prompt with new
   * variables always re-renders. A `cacheTtl` of `0` (or less) turns caching off
   * entirely — every call goes to the API, and nothing is stored, which also
   * gives up the serve-stale-while-offline behaviour above.
   *
   * @param name - The prompt name (slug, not ID).
   * @param alias - The alias to resolve (e.g. 'production', 'staging').
   * @param variables - Template variables to pass to the render endpoint.
   * @returns `{ messages, tools }`; `tools` is `[]` when the version has none.
   * @throws {acruxcoreError} MISSING_VARIABLES if the template requires variables not supplied.
   * @throws {acruxcoreError} API_ERROR for non-retryable HTTP errors (401, 404, 5xx after retries).
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable and no stale cache entry exists.
   */
  async renderPrompt(
    name: string,
    alias: string,
    variables: Record<string, unknown> = {},
  ): Promise<RenderResult> {
    // A non-positive TTL means "never serve a cached render" — skip the read and
    // pass a null key so _fetchAndCache skips the write too, instead of filling
    // the LRU with entries no read path will ever consult.
    if (this.cacheTtl <= 0) {
      return this._fetchAndCache(name, alias, variables, null);
    }

    const cache = getCache(DEFAULT_MAX_CACHE_SIZE);
    const cacheKey = `${hashApiKey(this.apiKey)}:${name}:${alias}:${hashVariables(variables)}`;
    const now = Date.now();

    const cached = cache.get(cacheKey);

    if (cached) {
      const age = now - cached.fetchedAt;
      if (age < this.cacheTtl) {
        return cached.value;
      }

      // Stale — return immediately and fire background refresh
      this._backgroundRefresh(name, alias, variables, cacheKey).catch((err: unknown) => {
        console.warn(
          `[acruxcore] Background refresh failed for "${name}/${alias}" — continuing to serve stale`,
          err instanceof Error ? err.message : err,
        );
      });

      return cached.value;
    }

    return this._fetchAndCache(name, alias, variables, cacheKey);
  }

  /** @internal */
  private async _backgroundRefresh(
    name: string,
    alias: string,
    variables: Record<string, unknown>,
    cacheKey: string,
  ): Promise<void> {
    await this._fetchAndCache(name, alias, variables, cacheKey);
  }

  /**
   * @internal Builds the Authorization/Content-Type header pair shared by every
   * authenticated request (Finding #22) — `_fetchAndCache`, `trace()`, and
   * `_request()` all call this instead of each hand-rolling its own headers
   * object, so a future header (e.g. `extraHeaders`) added to one automatically
   * applies to all three instead of silently drifting.
   */
  private _authHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
  }

  /** @internal */
  private async _fetchAndCache(
    name: string,
    alias: string,
    variables: Record<string, unknown>,
    cacheKey: string | null,
  ): Promise<RenderResult> {
    const url = `${this.baseUrl}/prompts/${encodeURIComponent(name)}/${encodeURIComponent(alias)}/render`;

    let response: Response;
    try {
      response = await fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: this._authHeaders(),
          body: JSON.stringify({ variables }),
        },
        this.maxRetries,
        this.retryInterval,
      );
    } catch (err) {
      throw new acruxcoreError(
        `acruxcore: network error fetching "${name}/${alias}" — ${err instanceof Error ? err.message : String(err)}`,
        'NETWORK_ERROR',
      );
    }

    if (!response.ok) {
      const body = await response.json().catch(() => undefined);

      if (response.status === 400 && body && typeof body === 'object') {
        // Body shape: { error: { code: 'MISSING_VARIABLES', message: '...', missing: [...] } }
        const errorField = (body as Record<string, unknown>).error;
        const missing =
          errorField && typeof errorField === 'object'
            ? (errorField as Record<string, unknown>).missing
            : undefined;
        if (Array.isArray(missing)) {
          throw new acruxcoreError(
            `acruxcore: missing required template variables: ${(missing as string[]).join(', ')}`,
            'MISSING_VARIABLES',
            400,
            body,
          );
        }
      }

      throw new acruxcoreError(
        `acruxcore API error ${response.status} for "${name}/${alias}"`,
        'API_ERROR',
        response.status,
        body,
      );
    }

    const data = await response.json() as {
      messages: Message[];
      tools?: ToolDefinition[];
      model?: string | null;
      versionId?: string | null;
      versionNumber?: number | null;
    };
    const value: RenderResult = {
      messages: data.messages,
      tools: data.tools ?? [],
      model: data.model ?? null,
      versionId: data.versionId ?? null,
      versionNumber: data.versionNumber ?? null,
    };

    if (cacheKey !== null) {
      const cache = getCache(DEFAULT_MAX_CACHE_SIZE);
      cache.set(cacheKey, { value, fetchedAt: Date.now() });
    }

    return value;
  }

  /**
   * Reports a trace (a group of spans — LLM calls, tool calls, retrieval, custom
   * chain steps) to acruxcore. A single-trace convenience over the batch
   * endpoint. Omit `input.traceId` to mint a new trace; pass a traceId returned by
   * a prior call (or minted by the gateway) to append spans to that same trace.
   *
   * Reuses the client's retry policy; this is a write, so it is never cached.
   *
   * @param input - The trace and its spans to report.
   * @returns The resolved `{ traceId }`.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   * @throws {acruxcoreError} API_ERROR for a non-2xx response (e.g. 400 validation,
   *         404 foreign trace id, 413 too many spans) — inspect `error.statusCode`/`error.body`.
   */
  async trace(input: TraceInput): Promise<TraceResult> {
    const url = `${this.baseUrl}/traces`;

    let response: Response;
    try {
      response = await fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: this._authHeaders(),
          body: JSON.stringify({ traces: [input] }),
        },
        this.maxRetries,
        this.retryInterval,
      );
    } catch (err) {
      throw new acruxcoreError(
        `acruxcore: network error reporting trace — ${err instanceof Error ? err.message : String(err)}`,
        'NETWORK_ERROR',
      );
    }

    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw new acruxcoreError(
        `acruxcore API error ${response.status} reporting trace`,
        'API_ERROR',
        response.status,
        body,
      );
    }

    const data = (await response.json()) as { accepted: number; traceIds: string[] };
    return { traceId: data.traceIds[0] };
  }

  /**
   * @internal Sends one batch of trace reports as a single `POST /traces`. Used only by
   * the span queue, which is why failures propagate rather than being swallowed here —
   * the queue turns them into one warning per error kind and drops the batch.
   *
   * @param batch - Trace entries to send in one request.
   * @throws {Error} On a network failure (from `fetchWithRetry`) or a non-2xx response.
   */
  private async _sendTraceBatch(batch: TraceInput[]): Promise<void> {
    const response = await fetchWithRetry(
      `${this.baseUrl}/traces`,
      {
        method: 'POST',
        headers: this._authHeaders(),
        body: JSON.stringify({ traces: batch }),
      },
      this.maxRetries,
      this.retryInterval,
    );
    // Read the body out either way, so the socket is released for the next batch rather
    // than left half-consumed — on a persistently failing endpoint the error path is the
    // one that runs every time.
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code =
        typeof body === 'object' && body !== null
          ? (body as { error?: { code?: string } }).error?.code
          : undefined;
      throw new Error(
        `acruxcore API error ${response.status} reporting traces${code ? ` (${code})` : ''}`,
      );
    }
  }

  /**
   * Waits until every trace this client reported in the background has been sent.
   *
   * `chat()`, streaming `chat()` and `runToolLoop()` hand back their result without
   * waiting for the trace write, so call this before reading the traces API back — in a
   * test, or in code that polls for the span it just produced. A script that simply
   * returns from `main()` does not need it: the SDK flushes as the process winds down.
   *
   * @returns Resolves once nothing is left to send. Never rejects — a failed report is
   *   warned about, never thrown into application code.
   */
  async flush(): Promise<void> {
    await this.spanQueue.flush();
  }

  /**
   * Flushes pending traces, then stops accepting new ones and releases the client's
   * exit hook. Idempotent.
   *
   * A long-running server should call this in the shutdown path it already has; the SDK
   * deliberately installs no signal handlers of its own, because doing so would suppress
   * Node's default terminate behaviour and break Ctrl-C in the consuming application.
   *
   * @returns Resolves once the final flush completes.
   */
  async close(): Promise<void> {
    unregisterExitFlush(this.exitRef);
    await this.spanQueue.close();
  }

  /**
   * Enables `await using hub = new acruxcore(...)` on runtimes that have
   * `Symbol.asyncDispose` (Node 20.4 and later). Equivalent to calling `close()`.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Generic authenticated fetch against this instance's baseUrl, mirroring
   * `trace()`'s retry/error handling.
   *
   * @internal Not part of the public API — callers go through typed methods. Public only
   *   so {@link ToolsNamespace} can reuse it instead of duplicating the retry handling.
   */
  async _request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    errorContext = `calling "${path}"`,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;

    try {
      return await fetchWithRetry(
        url,
        {
          method,
          headers: this._authHeaders(extraHeaders),
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        this.maxRetries,
        this.retryInterval,
      );
    } catch (err) {
      throw new acruxcoreError(
        `acruxcore: network error ${errorContext} — ${err instanceof Error ? err.message : String(err)}`,
        'NETWORK_ERROR',
      );
    }
  }

  /** @internal Throws acruxcoreError for a non-2xx response; otherwise returns parsed JSON. */
  async _parseJsonOrThrow(response: Response, errorContext: string): Promise<unknown> {
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw new acruxcoreError(`acruxcore API error ${response.status} ${errorContext}`, 'API_ERROR', response.status, body);
    }
    return response.json();
  }

  /** @internal Reads the gateway's `x-gateway-*` response metadata headers. */
  private _readGatewayMeta(response: Response): GatewayCallMeta {
    const costHeader = response.headers.get('x-gateway-cost-usd');
    return {
      requestId: response.headers.get('x-gateway-request-id'),
      provider: response.headers.get('x-gateway-provider'),
      model: response.headers.get('x-gateway-model'),
      costUsd: costHeader ? Number(costHeader) : null,
      cache: response.headers.get('x-gateway-cache'),
      traceId: response.headers.get('x-gateway-trace-id'),
      spanRef: response.headers.get('x-gateway-span-id'),
    };
  }

  /** @internal Builds the JSON body shared by chat() and runToolLoop()'s gateway calls. */
  private _buildChatBody(options: ChatOptions): Record<string, unknown> {
    const body: Record<string, unknown> = { model: options.model, messages: options.messages };
    if (options.tools) body['tools'] = options.tools;
    if (options.toolRefs) body['tool_refs'] = options.toolRefs;
    if (options.toolChoice) body['tool_choice'] = options.toolChoice;
    if (options.responseFormat) body['response_format'] = options.responseFormat;
    if (options.temperature !== undefined) body['temperature'] = options.temperature;
    if (options.maxTokens !== undefined) body['max_tokens'] = options.maxTokens;
    if (options.stream) body['stream'] = true;
    return body;
  }

  /**
   * Calls the gateway's `POST /gateway/chat/completions` by default — a single
   * request/response, no tool-dispatch loop. If `options.provider` is set (or, absent
   * that, the client's own `config.provider` default), this instead calls that BYO
   * provider's `baseUrl` directly, skipping the gateway entirely — see
   * {@link ProviderConfig}. If the model returns `tool_calls`, they are handed back raw
   * on `result.message.tool_calls` rather than being auto-dispatched; use `runToolLoop`
   * for that.
   *
   * Tracing (`options.trace`): on the BYO path this call auto-reports a trace with one
   * `llm` span by **default** — nothing else observes a direct-to-provider call, so
   * without this it would be invisible. On the gateway path the default stays `false`
   * — the gateway already records its own `llm` span for every completion, and its
   * `gateway` metadata (request id, provider, cost, cache) is returned so you can
   * correlate with it or build your own span. Either path accepts an explicit
   * `trace: true` / `trace: { traceId, sessionId? }` to opt in, e.g. to append this
   * call's span to a trace/session from an earlier call (several manual `chat()`
   * calls forming one turn).
   *
   * Opting in on the **gateway** path always produces a SECOND trace-write in
   * addition to the gateway's own recorded completion: a fresh client-side `llm`
   * span, with an id minted here rather than reused from `result.gateway.spanRef`
   * (that ref names the row the gateway already persisted, so reusing it would
   * collide with it under the spans table's unique `(traceId, spanRef)`
   * constraint). Without `trace.traceId` the span is appended to the gateway's own
   * trace, which then holds two `llm` spans for one completion; with an explicit
   * `trace.traceId` it lands in *your* trace and the gateway's own trace stays
   * separate — so one completion is represented twice either way. That is the
   * intended effect of opting in explicitly; leave `trace` unset on the gateway
   * path if you only want the gateway's own span. Pass `trace: false` to skip
   * reporting entirely regardless of path. A failed trace report is logged and
   * swallowed — it never fails the `chat()` call.
   * `options.promptVersionId` (from `renderPrompt()`) is stamped on the reported span
   * for lineage. On the BYO path there is no gateway trace to adopt, so a fresh
   * `traceId`/`spanRef` is minted locally and `costUsd`/`cache` are always `null` (the
   * gateway never saw the call).
   *
   * Streaming (`options.stream: true`) with a `provider` set streams the BYO endpoint's
   * SSE response directly — never through our gateway — requesting
   * `stream_options: { include_usage: true }` so the final frame carries token usage.
   * Content is accumulated across chunks and, once the stream ends, the same auto-trace
   * default as above reports one `llm` span with the assembled output and usage
   * (deferred until then, since streaming has no single response to trace at return
   * time). Streaming without a `provider` set is unchanged: it streams our gateway and
   * reports no client-side trace (the gateway traces its own completions).
   *
   * @param options - Model, messages, optional tools/toolRefs/toolChoice, generation
   *   params, an optional per-call `provider` override, `promptVersionId`, and tracing
   *   options.
   * @returns A {@link ChatResult} when `stream` is falsy, or an async iterable of
   *   {@link ChatChunk} when `stream: true`.
   * @throws {acruxcoreError} MISSING_API_KEY if `options.provider.apiKey` is empty.
   * @throws {acruxcoreError} MISSING_BASE_URL if `options.provider.baseUrl` is empty.
   * @throws {acruxcoreError} NETWORK_ERROR if the gateway (or, on the BYO path, the
   *   provider endpoint) is unreachable after retries.
   * @throws {acruxcoreError} API_ERROR for a non-2xx response from the gateway (e.g. 403
   *   MODEL_NOT_ALLOWED, 402 BUDGET_EXCEEDED) — inspect `error.statusCode`/`error.body`.
   * @throws {acruxcoreError} PROVIDER_ERROR for a non-2xx response from a BYO provider
   *   endpoint (`options.provider` or the client-level default) — inspect
   *   `error.statusCode`/`error.body`.
   */
  async chat(options: ChatOptions & { stream: true }): Promise<AsyncGenerator<ChatChunk>>;
  async chat(options: ChatOptions & { stream?: false | undefined }): Promise<ChatResult>;
  async chat(options: ChatOptions): Promise<ChatResult | AsyncGenerator<ChatChunk>> {
    // Resolve a zod-built responseFormat to the OpenAI-shaped wire dict ONCE here, so the
    // rest of the pipeline (the synchronous _buildChatBody) only sees the plain dict. The
    // conversion is async (zod is dynamically imported as an optional peer).
    options.responseFormat = await resolveResponseFormat(options.responseFormat) as ChatOptions['responseFormat'];
    const providerConfig = options.provider ?? this.providerDefault;

    const traceOpt = options.trace ?? Boolean(providerConfig);
    const traceEnabled = traceOpt !== false;
    const traceConf = typeof traceOpt === 'object' ? traceOpt : {};

    // Thread trace tags/metadata to the gateway so the trace is tagged server-side.
    const traceHeaders: Record<string, string> | undefined = traceEnabled && !providerConfig
      ? {
          ...(traceConf.tags?.length ? { 'x-trace-tags': traceConf.tags.join(', ') } : {}),
          ...(traceConf.metadata && Object.keys(traceConf.metadata).length
            ? { 'x-trace-metadata': JSON.stringify(traceConf.metadata) }
            : {}),
        }
      : undefined;

    if (options.stream) {
      return providerConfig
        ? this._streamViaProvider(options, providerConfig)
        : this._streamChat(this._buildChatBody(options), traceHeaders);
    }

    const startTime = new Date().toISOString();
    const result = providerConfig
      ? await this._completeViaProvider(options, providerConfig)
      : await this._completeOnce(options, traceHeaders);

    if (traceEnabled) {
      // On the gateway path, result.gateway.spanRef is the span the GATEWAY already
      // persisted server-side — reusing it here would collide with that row under
      // spans' unique (traceId, spanRef) constraint, which is a Prisma P2002 → a 500
      // this method's own best-effort catch would then silently swallow. Only the BYO
      // path's freshly-minted spanRef (from _completeViaProvider, nothing persisted
      // under it yet) is safe to reuse as-is, which keeps the span id on the trace
      // consistent with the `result.gateway.spanRef` handed back to the caller.
      const spanId = providerConfig
        ? (result.gateway.spanRef ?? `chat-${randomUUID()}`)
        : `chat-${randomUUID()}`;
      const traceId = traceConf.traceId ?? result.gateway.traceId ?? undefined;
      // Enqueued, not awaited: the caller has their answer already and nothing in their
      // application depends on the write. Delivery is best-effort: the queue keeps order and
      // warns once per failure kind, the transport retries transient failures, but a batch
      // that still fails is dropped, and the oldest spans go once the buffer is over its
      // memory cap. `flush()` is how a caller waits for what is buffered (see SpanQueue).
      this.spanQueue.enqueue({
        traceId,
        sessionId: traceConf.sessionId,
        name: 'chat',
        spans: [{
          spanId,
          name: result.model,
          kind: 'llm',
          status: 'ok',
          startTime,
          endTime: new Date().toISOString(),
          model: result.model,
          provider: result.gateway.provider ?? undefined,
          usage: result.usage,
          costUsd: result.gateway.costUsd ?? undefined,
          promptVersionId: options.promptVersionId,
          input: { messages: options.messages },
          output: result.message,
        }],
      });
    }

    return result;
  }

  /**
   * @internal One non-streaming gateway completion. Shared by the public `chat()`
   * and `runToolLoop`; `extraHeaders` lets the loop thread trace context
   * (`x-trace-id`, `x-trace-name`) so every round-trip lands in one trace.
   */
  private async _completeOnce(options: ChatOptions, extraHeaders?: Record<string, string>): Promise<ChatResult> {
    const body = this._buildChatBody(options);
    const response = await this._request('POST', '/gateway/chat/completions', body, 'calling chat completions', extraHeaders);
    const gateway = this._readGatewayMeta(response);
    const data = (await this._parseJsonOrThrow(response, 'calling chat completions')) as {
      id: string;
      model: string;
      choices: { message: Message; finish_reason: string | null }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const choice = data.choices[0];
    return {
      id: data.id,
      model: data.model,
      content: choice.message.content ?? null,
      message: choice.message,
      finishReason: choice.finish_reason,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
      gateway,
    };
  }

  /**
   * @internal One non-streaming completion sent DIRECTLY to a BYO provider's
   * baseUrl — never through our gateway. `providerConfig.apiKey` is sent only to
   * `providerConfig.baseUrl`, never to us. Mints its own trace id + llm span ref
   * (no `x-gateway-*` headers exist on this path) so the returned `gateway` field
   * has the same shape callers already read from the gateway path.
   */
  private async _completeViaProvider(
    options: ChatOptions,
    providerConfig: ProviderConfig,
  ): Promise<ChatResult> {
    if (!providerConfig.apiKey) {
      throw new acruxcoreError(
        'acruxcore: provider.apiKey is required for a BYO (direct-provider) call.',
        'MISSING_API_KEY',
      );
    }
    if (!providerConfig.baseUrl) {
      throw new acruxcoreError(
        'acruxcore: provider.baseUrl is required for a BYO (direct-provider) call.',
        'MISSING_BASE_URL',
      );
    }

    warnIfCleartextUrl(providerConfig.baseUrl, 'provider.baseUrl');

    const body = this._buildChatBody(options);
    const url = `${providerConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    let response: Response;
    try {
      response = await fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${providerConfig.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
        this.maxRetries,
        this.retryInterval,
      );
    } catch (err) {
      throw new acruxcoreError(
        `acruxcore: network error calling provider — ${err instanceof Error ? err.message : String(err)}`,
        'NETWORK_ERROR',
      );
    }

    if (!response.ok) {
      const errBody = await response.json().catch(() => undefined);
      throw new acruxcoreError(
        `acruxcore: provider returned ${response.status} calling chat completions`,
        'PROVIDER_ERROR',
        response.status,
        errBody,
      );
    }

    const data = (await response.json()) as {
      id: string;
      model: string;
      choices: { message: Message; finish_reason: string | null }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const choice = data.choices[0];

    return {
      id: data.id,
      model: data.model,
      content: choice.message.content ?? null,
      message: choice.message,
      finishReason: choice.finish_reason,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
      gateway: {
        requestId: data.id,
        provider: inferProviderName(providerConfig.baseUrl),
        model: data.model,
        costUsd: null,
        cache: null,
        traceId: randomUUID(),
        spanRef: randomUUID(),
      },
    };
  }

  /**
   * @internal Streams `POST /gateway/chat/completions` (`stream: true`) and yields one
   * {@link ChatChunk} per `chat.completion.chunk` SSE frame, stopping at `data: [DONE]`.
   */
  private async *_streamChat(body: Record<string, unknown>, extraHeaders?: Record<string, string>): AsyncGenerator<ChatChunk> {
    const response = await this._request('POST', '/gateway/chat/completions', body, 'streaming chat completions', extraHeaders);
    if (!response.ok) {
      await this._parseJsonOrThrow(response, 'streaming chat completions');
      return;
    }
    if (!response.body) {
      throw new acruxcoreError('acruxcore: streaming response had no body', 'NETWORK_ERROR');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let separatorIndex: number;
        while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, separatorIndex).trim();
          buffer = buffer.slice(separatorIndex + 2);
          if (!frame.startsWith('data:')) continue;

          const data = frame.slice('data:'.length).trim();
          if (data === '[DONE]') return;

          const parsed = JSON.parse(data) as {
            id: string;
            model: string;
            choices: { delta: { role?: string; content?: string }; finish_reason: string | null }[];
          };
          const choice = parsed.choices[0];
          yield {
            id: parsed.id,
            model: parsed.model,
            delta: choice?.delta ?? {},
            finishReason: choice?.finish_reason ?? null,
          };
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * @internal Streams a BYO provider's `/chat/completions` (`stream: true`) directly
   * — never through our gateway. Requests `stream_options.include_usage` so the final
   * SSE frame carries token usage. Accumulates assistant `content` and `tool_calls`
   * fragments across chunks (mirroring what the gateway's own `finalize()` does
   * server-side, keyed by the wire `index` that correlates a tool call's fragments
   * across frames), and — when tracing is enabled — reports one `llm` span at stream
   * end with the assembled output (content plus any tool calls) and usage.
   */
  private async *_streamViaProvider(
    options: ChatOptions,
    providerConfig: ProviderConfig,
  ): AsyncGenerator<ChatChunk> {
    if (!providerConfig.apiKey) {
      throw new acruxcoreError(
        'acruxcore: provider.apiKey is required for a BYO (direct-provider) call.',
        'MISSING_API_KEY',
      );
    }
    if (!providerConfig.baseUrl) {
      throw new acruxcoreError(
        'acruxcore: provider.baseUrl is required for a BYO (direct-provider) call.',
        'MISSING_BASE_URL',
      );
    }

    warnIfCleartextUrl(providerConfig.baseUrl, 'provider.baseUrl');

    const body = { ...this._buildChatBody(options), stream_options: { include_usage: true } };
    const url = `${providerConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const startTime = new Date().toISOString();

    let response: Response;
    try {
      response = await fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${providerConfig.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
        this.maxRetries,
        this.retryInterval,
      );
    } catch (err) {
      throw new acruxcoreError(
        `acruxcore: network error streaming from provider — ${err instanceof Error ? err.message : String(err)}`,
        'NETWORK_ERROR',
      );
    }

    if (!response.ok) {
      const errBody = await response.json().catch(() => undefined);
      throw new acruxcoreError(
        `acruxcore: provider returned ${response.status} streaming chat completions`,
        'PROVIDER_ERROR',
        response.status,
        errBody,
      );
    }
    if (!response.body) {
      throw new acruxcoreError('acruxcore: streaming response had no body', 'NETWORK_ERROR');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulatedContent = '';
    let finalModel = options.model;
    let usage: ChatUsage | undefined;
    let finishReason: string | null = null;
    // Tool-call fragments, keyed by the wire `index` that correlates them across
    // frames. A streamed turn never yields a whole message, so without this the
    // trace payload for a tool-calling turn would record an empty output.
    const toolCallParts = new Map<number, { id: string; name: string; arguments: string }>();

    // `[DONE]` ends the response, but it only breaks the frame loop — this carries
    // that out to the read loop so we stop reading instead of blocking for a close
    // that a keep-alive proxy may never send. (Not a `return`: the trace span below
    // still has to be reported.)
    let streamDone = false;

    try {
      while (!streamDone) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let separatorIndex: number;
        while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, separatorIndex).trim();
          buffer = buffer.slice(separatorIndex + 2);
          if (!frame.startsWith('data:')) continue;

          const dataStr = frame.slice('data:'.length).trim();
          if (dataStr === '[DONE]') {
            streamDone = true;
            break;
          }

          const parsed = JSON.parse(dataStr) as {
            id: string;
            model: string;
            choices?: {
              delta: {
                role?: string;
                content?: string;
                tool_calls?: { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
              };
              finish_reason: string | null;
            }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          finalModel = parsed.model ?? finalModel;
          if (parsed.usage) {
            usage = {
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens,
              totalTokens: parsed.usage.total_tokens,
            };
          }
          const choice = parsed.choices?.[0];
          if (choice?.delta.content) accumulatedContent += choice.delta.content;
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          for (const tc of choice?.delta.tool_calls ?? []) {
            const key = tc.index ?? 0;
            const part = toolCallParts.get(key) ?? { id: '', name: '', arguments: '' };
            if (tc.id) part.id = tc.id;
            if (tc.function?.name) part.name = tc.function.name;
            if (tc.function?.arguments) part.arguments += tc.function.arguments;
            toolCallParts.set(key, part);
          }

          yield {
            id: parsed.id,
            model: parsed.model,
            delta: choice?.delta ?? {},
            finishReason: choice?.finish_reason ?? null,
          };
        }
      }
    } finally {
      reader.releaseLock();
    }

    const traceOpt = options.trace ?? true;
    if (traceOpt !== false) {
      const traceConf = typeof traceOpt === 'object' ? traceOpt : {};
      const assembledToolCalls: ToolCall[] = [...toolCallParts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, p]) => ({ id: p.id, type: 'function' as const, function: { name: p.name, arguments: p.arguments } }));
      // Enqueued, not awaited — see the note at chat()'s own auto-report.
      this.spanQueue.enqueue({
        traceId: traceConf.traceId,
        sessionId: traceConf.sessionId,
        name: 'chat',
        spans: [{
          spanId: randomUUID(),
          name: finalModel,
          kind: 'llm',
          status: 'ok',
          startTime,
          endTime: new Date().toISOString(),
          model: finalModel,
          provider: inferProviderName(providerConfig.baseUrl),
          usage,
          promptVersionId: options.promptVersionId,
          input: { messages: options.messages },
          output: {
            role: 'assistant',
            content: accumulatedContent,
            ...(assembledToolCalls.length ? { tool_calls: assembledToolCalls } : {}),
          },
          // Surfaced on the span rather than dropped (final review M3): a streamed
          // turn has no single response object, so `finishReason` is the only record
          // of WHY the stream ended (`stop` vs `length` vs `tool_calls`).
          ...(finishReason ? { attributes: { finishReason } } : {}),
        }],
      });
    }
  }

  /**
   * Runs the full tool-calling loop against the gateway: calls the model, runs whatever
   * tools it asks for, appends the results, and repeats until the model stops calling
   * tools or `maxIterations` is reached. When a single model turn requests several tools
   * they run **concurrently** (`Promise.allSettled`), with results appended in call order.
   *
   * **Who runs a tool** is decided once, before the first model call:
   *
   * | Source | Runs where |
   * | --- | --- |
   * | `tools: [acrux.tool(...)]` | The declared handler, locally |
   * | `toolRefs` resolving to `http` | On the platform, via the executor |
   * | `toolRefs` resolving to `client` | A matching declared tool, else `dispatch` |
   * | `toolDefs: [rawDefinition]` | `dispatch` |
   *
   * A `client` executor with no declared match and no `dispatch` throws
   * `MISSING_DISPATCH` **before** the model is called, so the failure costs no tokens.
   *
   * Declared tools are passed to the gateway as `tool_refs`, never as an inline schema:
   * the model is served the schema the catalog holds, so the declared schema and the
   * served schema cannot drift apart.
   *
   * Auto-reports one trace covering the whole loop (`trace` defaults to `true`): the
   * gateway records an `llm` span per round-trip and the SDK adds a `tool` span per
   * locally-run tool, with real timing and the gateway's usage/cost metadata. A
   * platform-side execution gets its span from the platform, so the SDK reports none for
   * it. Pass `trace: false` to skip, or `trace: { traceId }` to append to an existing trace.
   *
   * If `options.provider` is set (or, absent that, the client's own `config.provider`
   * default), every round-trip in the loop calls that BYO provider's `baseUrl` directly
   * instead of the gateway — see {@link ProviderConfig}. A BYO provider has no
   * server-side catalog to resolve `tool_refs` against, so on this path every tool
   * (declared, ref-resolved, and raw `toolDefs`) is sent inline as a full JSON-Schema
   * `tools` definition instead. Because there is no gateway to record its own `llm`
   * span, the SDK reports one `llm` span per round-trip itself (stamped with
   * `options.promptVersionId`, output set to the round's full assistant message
   * including any `tool_calls`) in addition to the usual `tool` spans, all threaded
   * onto the same trace. Each BYO `llm` span is reported as its round returns rather than
   * held to the end, so a long BYO loop is observable while it runs. Only the *first*
   * round's span is awaited, and only when a platform-executed (`http`) tool can dispatch
   * during this loop: that one round-trip guarantees the trace row exists before the
   * platform writes its own span under it. Every later round is queued in the background —
   * `parentSpanRef` is not a foreign key, so a tool span stored ahead of its parent `llm`
   * span still nests correctly once that span is flushed.
   *
   * @param options - Model, seed messages, tools/toolDefs/toolRefs, optional dispatch, an
   *   optional per-call `provider` override, and tracing options.
   * @returns The final assistant text, the full transcript, iteration count, whether the loop
   *   stopped at the iteration cap, and the traceId spans were reported under (if any).
   * @throws {acruxcoreError} MISSING_DISPATCH when a tool has no runner; API_ERROR on a
   *   non-2xx gateway, sync, resolve or execute response; PROVIDER_ERROR on a non-2xx
   *   response from a BYO provider endpoint.
   * @throws Whatever a tool handler or `options.dispatch` throws — it is not caught here and
   *   propagates out of `runToolLoop`; wrap it yourself if you want a tool failure reported
   *   back to the model as a tool-result message instead.
   */
  /**
   * Reconciles and resolves once, returning the name→runner table and the refs to send.
   *
   * Runs before the first model call on purpose: every failure mode here (an unsyncable
   * spec, an unresolvable ref, a missing dispatch) is cheaper to hit now than three turns
   * into a conversation.
   *
   * @param options - The loop's options; `tools`, `toolRefs`, `dispatch` and `sync`.
   * @returns `{ routes, refs, inlinedSchemas }` — `refs` is what goes on the wire as
   *   `tool_refs` for the gateway path, and includes one entry per declared tool.
   *   `inlinedSchemas` is the full JSON-Schema `tools` shape for every declared/ref-resolved
   *   tool, used instead of `refs` when calling a BYO provider directly (it has no
   *   server-side catalog to resolve refs against).
   * @throws {acruxcoreError} TOOL_SCHEMA_ERROR when something in `tools` was not created
   *   by `acrux.tool`; MISSING_DISPATCH when a `client` ref has neither a declared tool
   *   nor a `dispatch` to fall back on.
   */
  private async _prepareToolRoutes(
    options: RunToolLoopOptions,
  ): Promise<{
    routes: Map<string, ToolRoute>;
    refs: { name: string; alias?: string }[];
    inlinedSchemas: ToolDefinition[];
  }> {
    const routes = new Map<string, ToolRoute>();
    const refs: { name: string; alias?: string }[] = [];
    const inlinedSchemas: ToolDefinition[] = [];

    // 1) Declared tools. Always client-side, so no resolve round-trip is needed — sync
    // already guarantees the catalog holds this exact spec.
    for (const t of options.tools ?? []) {
      if (!isAcruxTool(t)) {
        throw new acruxcoreError(
          'acruxcore: a value passed to tools was not created by acrux.tool. Declare it with ' +
            'acrux.tool({ name, parameters }, handler), or pass raw OpenAI tool definitions as ' +
            'toolDefs instead.',
          'TOOL_SCHEMA_ERROR',
        );
      }
      let toolVersionId: string | undefined;
      if (options.sync !== false) {
        const result = await this.tools.syncOne(t);
        toolVersionId = `${result.toolId}:${result.versionNumber}`;
      }
      routes.set(t.name, { kind: 'local', tool: t, alias: t.alias, toolVersionId });
      refs.push({ name: t.name, alias: t.alias });
      inlinedSchemas.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: await resolveParametersSchema(t.parameters),
        },
      });
    }

    // 2) Caller-supplied catalog refs. One batch resolve tells us who runs each.
    const callerRefs = options.toolRefs ?? [];
    if (callerRefs.length > 0) {
      const resolved: ResolvedTool[] = await this.tools.resolve(callerRefs);
      callerRefs.forEach((ref, index) => {
        const item = resolved[index];
        if (!item) return;
        const name = item.function.name;
        const versionId = `${item.toolId}:${item.versionNumber}`;
        // A declared tool of the same name wins: the caller wrote the body, so running it
        // elsewhere would ignore their code.
        if (routes.has(name)) return;
        if (item.executorType === 'http') {
          routes.set(name, {
            kind: 'http',
            toolId: item.toolId,
            alias: ref.alias,
            toolVersionId: versionId,
          });
        } else if (options.dispatch) {
          routes.set(name, { kind: 'dispatch', alias: ref.alias, toolVersionId: versionId });
        } else {
          throw new acruxcoreError(
            `acruxcore: tool '${name}' has a client executor, so something has to run it, but ` +
              'no implementation was supplied. Pass the declared tool in tools: [...], or pass ' +
              'dispatch.',
            'MISSING_DISPATCH',
          );
        }
        refs.push({ name, ...(ref.alias ? { alias: ref.alias } : {}) });
        inlinedSchemas.push({ type: 'function', function: item.function });
      });
    }

    return { routes, refs, inlinedSchemas };
  }

  async runToolLoop(options: RunToolLoopOptions): Promise<RunToolLoopResult> {
    // Resolve a zod-built responseFormat to the OpenAI-shaped wire dict ONCE here, so both
    // the gather phase (stripped) and the shaping phase carry the plain dict the gateway
    // expects. Async because zod is dynamically imported as an optional peer.
    options.responseFormat = await resolveResponseFormat(options.responseFormat) as RunToolLoopOptions['responseFormat'];
    const hasTools =
      (options.tools?.length ?? 0) + (options.toolDefs?.length ?? 0) + (options.toolRefs?.length ?? 0) > 0;
    const shaping = !!options.responseFormat && hasTools;

    // Phase 1: gather facts. When shaping, strip response_format from every round — the
    // gateway rejects tools + response_format on one request (Anthropic fakes response_format
    // as a forced tool that cannot share a request with real tools), so the SDK splits the two.
    const gathered = await this._runToolLoopGather(options, shaping ? undefined : options.responseFormat, undefined);
    if (!shaping) return gathered;

    // Phase 2: shape phase 1's gathered facts into the typed response_format answer, on the
    // SAME trace, with no tools attached. Drop phase 1's trailing free-text assistant turn and
    // nudge the model to emit the JSON the schema asks for.
    const shapeNudge = 'Produce your final response now, as the JSON object defined by the response schema.';
    let shapeMessages = gathered.messages.slice();
    const last = shapeMessages[shapeMessages.length - 1];
    if (last && last.role === 'assistant' && !last.tool_calls) shapeMessages = shapeMessages.slice(0, -1);
    shapeMessages.push({ role: 'user', content: shapeNudge });
    const shaped = await this._runToolLoopGather(
      { ...options, tools: undefined, toolDefs: undefined, toolRefs: undefined, messages: shapeMessages },
      options.responseFormat,
      gathered.traceId,
    );
    const shapedAssistant = shaped.messages[shaped.messages.length - 1];
    return {
      content: shaped.content ?? '',
      messages: shapedAssistant
        ? [...gathered.messages, { role: 'user', content: shapeNudge }, shapedAssistant]
        : gathered.messages,
      iterations: gathered.iterations,
      stoppedAtLimit: gathered.stoppedAtLimit,
      traceId: gathered.traceId ?? shaped.traceId,
    };
  }

  /**
   * @internal The gather loop shared by {@link runToolLoop}'s two phases. Phase 1 passes the
   * caller's tools (and no `response_format` when the call is shaping); phase 2 passes
   * `response_format` and no tools, seeded onto phase 1's trace. Runs the model, dispatches
   * tool calls, and stops when the model stops calling tools or the iteration limit is hit.
   */
  private async _runToolLoopGather(
    options: RunToolLoopOptions,
    effectiveResponseFormat: ResponseFormat | undefined,
    seedTraceId: string | undefined,
  ): Promise<RunToolLoopResult> {
    const { routes, refs: effectiveRefs, inlinedSchemas } = await this._prepareToolRoutes(options);
    const max = options.maxIterations ?? 10;
    const traceOpt = options.trace ?? true;
    const traceEnabled = traceOpt !== false;
    const traceConf = traceOpt === true || traceOpt === undefined || traceOpt === false ? {} : traceOpt;
    const traceName = traceConf.name ?? 'runToolLoop';
    const providerConfig = options.provider ?? this.providerDefault;
    // A BYO provider has no server-side catalog to resolve tool_refs against, so every
    // tool — declared, ref-resolved, and raw toolDefs — must be inlined as a full schema.
    // Empty when phase 2 calls this with no tools — send `undefined`, not `tools: []`.
    const byoToolSchemas = providerConfig && ([...(options.toolDefs ?? []), ...inlinedSchemas].length > 0)
      ? [...(options.toolDefs ?? []), ...inlinedSchemas]
      : undefined;

    let messages: Message[] = [...options.messages];
    // Only TOOL spans are batched here, on BOTH paths. On the gateway path the gateway
    // records each `llm` round-trip as its own span (with payloads) directly onto the
    // shared trace, so duplicating them here would double-count and lose payload
    // capture; on the BYO path the SDK owns the `llm` span but reports it immediately
    // per round (see below) rather than deferring it into this array.
    const toolSpans: IngestSpan[] = [];
    // The single trace every span lands in. Seeded from an explicit `trace.traceId`
    // if given; otherwise adopted from the first gateway response so subsequent
    // round-trips and the tool spans all thread into that same trace.
    let traceId: string | undefined = seedTraceId ?? traceConf.traceId;

    for (let i = 0; i < max; i++) {
      // Thread trace context so the gateway nests this call's `llm` span into our
      // trace instead of minting a fresh one per round-trip (the "two traces" bug).
      // Percent-encode the name: header values must be ISO-8859-1, but a trace
      // name is free text and may contain any Unicode (which would make the
      // fetch throw). The gateway decodes it back. traceId is an ASCII UUID.
      // Send x-session-id too, so the gateway stamps the session when it CREATES
      // the trace (it's session-less otherwise, so the run never shows under a
      // session). Session ids are plain identifiers; the gateway reads it raw.
      // Skipped entirely on the BYO path (final review M11): these headers are only
      // ever handed to `_completeOnce`, i.e. to the gateway.
      const extraHeaders: Record<string, string> | undefined = traceEnabled && !providerConfig
        ? {
            'x-trace-name': encodeURIComponent(traceName),
            ...(traceId ? { 'x-trace-id': traceId } : {}),
            ...(traceConf.sessionId ? { 'x-session-id': traceConf.sessionId } : {}),
            ...(traceConf.tags?.length ? { 'x-trace-tags': traceConf.tags.join(', ') } : {}),
            ...(traceConf.metadata && Object.keys(traceConf.metadata).length
              ? { 'x-trace-metadata': JSON.stringify(traceConf.metadata) }
              : {}),
          }
        : undefined;

      const roundStartTime = new Date().toISOString();
      const result = providerConfig
        ? await this._completeViaProvider(
            {
              model: options.model,
              messages,
              tools: byoToolSchemas,
              temperature: options.temperature,
              maxTokens: options.maxTokens,
              responseFormat: effectiveResponseFormat,
            },
            providerConfig,
          )
        : await this._completeOnce(
            {
              model: options.model,
              messages,
              tools: options.toolDefs?.length ? options.toolDefs : undefined,
              // Declared tools go out as refs, never as an inline schema: the model is served
              // the schema the catalog holds, so the two cannot drift apart.
              toolRefs: effectiveRefs.length > 0 ? effectiveRefs : undefined,
              temperature: options.temperature,
              maxTokens: options.maxTokens,
              responseFormat: effectiveResponseFormat,
            },
            extraHeaders,
          );

      // Adopt the trace on the first round; reuse it thereafter. On the gateway path this
      // is the gateway's own trace id; on the BYO path it's the id `_completeViaProvider`
      // mints locally for this round (only the first round's id is kept).
      if (traceEnabled && !traceId) traceId = result.gateway.traceId ?? undefined;
      // Parent for THIS round's tool spans: the gateway's `llm` span for this call.
      const llmSpanRef = result.gateway.spanRef ?? undefined;

      // The gateway reports its own `llm` span for a gateway round-trip, so the SDK adds
      // only `tool` spans there. A BYO round-trip has no such server-side span — mirror
      // chat()'s auto-trace here so each round's completion (including any tool_calls in
      // its output) is still visible on the trace.
      if (providerConfig && traceEnabled) {
        const llmSpanId = result.gateway.spanRef ?? `llm-${i}`;
        const llmSpan: IngestSpan = {
          spanId: llmSpanId,
          name: result.model,
          kind: 'llm',
          status: 'ok',
          // Captured BEFORE the completion call, not at push time — stamping both ends
          // after the call returned made every BYO round report latencyMs: 0, which is
          // the one number BYO exists to improve (final review I2).
          startTime: roundStartTime,
          endTime: new Date().toISOString(),
          model: result.model,
          provider: result.gateway.provider ?? undefined,
          usage: result.usage,
          promptVersionId: options.promptVersionId,
          input: { messages },
          output: result.message,
        };
        const roundTrace: TraceInput = {
          traceId,
          name: traceName,
          sessionId: traceConf.sessionId,
          spans: [llmSpan],
        };
        // Round 0 is AWAITED, and only when a server-side (http) tool can dispatch during
        // this loop. apps/api/src/tools/execute/execute.service.ts resolves the trace by
        // id, and if the row does not exist yet it creates one named `tool:<toolName>` and
        // drops the supplied parentSpanId — the mis-named trace with an orphaned tool span
        // of final review I5. Awaiting here guarantees the trace row exists before the
        // first dispatch.
        //
        // Later rounds never need it: `parentSpanRef` is a plain nullable String on the
        // Span model, not a foreign key, and the server-written tool span skips the ingest
        // parent check entirely — so a tool span stored before its parent llm span still
        // nests correctly once that span is flushed. That bounds the worst case at one
        // round-trip per loop instead of one per round, and at zero when every tool runs
        // client-side.
        const mustAwaitTraceOpen = i === 0 && [...routes.values()].some((r) => r.kind === 'http');
        if (mustAwaitTraceOpen) {
          try {
            await this.trace(roundTrace);
          } catch (err) {
            console.warn('[acruxcore] runToolLoop llm-span report failed — continuing without it', err instanceof Error ? err.message : err);
          }
        } else {
          this.spanQueue.enqueue(roundTrace);
        }
      }

      const calls = result.message.tool_calls ?? [];
      if (result.finishReason !== 'tool_calls' || calls.length === 0) {
        this._reportToolSpans(traceEnabled, traceId, traceName, traceConf.sessionId, toolSpans);
        return { content: result.content ?? '', messages: [...messages, result.message], iterations: i + 1, stoppedAtLimit: false, traceId };
      }

      // Dispatch every tool call the model asked for concurrently: the model
      // returns them in one turn precisely so independent tools can run in
      // parallel rather than waiting on each other. `allSettled` lets every
      // call finish and record its span even if a sibling throws; afterwards we
      // report the trace and re-throw the first failure (in call order),
      // preserving the previous sequential loop's error contract.
      const settled = await Promise.allSettled(
        calls.map(async (call, callIndex): Promise<Message> => {
          const name = call.function.name;
          let args: Record<string, unknown> = {};
          try { const p = JSON.parse(call.function.arguments || '{}'); if (p && typeof p === 'object') args = p as Record<string, unknown>; } catch { /* keep {} */ }

          const route = routes.get(name);

          // A server-side execution is traced BY the platform, with the version that ran
          // and the real payloads. Reporting a span here too would show one execution as
          // two.
          if (route?.kind === 'http') {
            const executed = await this.tools.execute(route.toolId ?? '', args, {
              alias: route.alias,
              traceId: traceEnabled ? traceId : undefined,
              parentSpanId: llmSpanRef,
            });
            const ret = executed.result;
            const content = typeof ret === 'string' ? ret : (JSON.stringify(ret) ?? 'null');
            return { role: 'tool', tool_call_id: call.id, content };
          }

          let run: () => Promise<unknown> | unknown;
          if (route?.kind === 'local' && route.tool) {
            const declared = route.tool;
            // parseToolArgs runs the zod schema when there is one, so a bad model argument
            // fails at the boundary rather than deep inside the handler.
            run = () => declared.handler(parseToolArgs(declared, args));
          } else if (options.dispatch) {
            const dispatch = options.dispatch;
            run = () => dispatch(name, args);
          } else {
            throw new acruxcoreError(
              `acruxcore: the model called '${name}', which has no implementation. Pass the ` +
                'declared tool in tools: [...], or pass dispatch.',
              'MISSING_DISPATCH',
            );
          }

          const toolSpanId = `tool-${i}-${callIndex}`;
          const toolStart = new Date().toISOString();
          // attributes now carry the version that ran and who ran it, which is what a tool
          // span used to be missing entirely.
          const attributes: Record<string, unknown> = {
            arguments: args,
            executorType: 'client',
            ...(route?.toolVersionId ? { toolVersionId: route.toolVersionId } : {}),
          };
          // Promise.resolve wraps a sync-or-async return uniformly.
          return Promise.resolve(run()).then(
            (result2): Message => {
              // input/output carry the call's arguments + result as the span payload
              // (stored only when capture is on), so a tool span shows what it was
              // called with and what it returned — not just "Payload not captured".
              toolSpans.push({
                spanId: toolSpanId, parentSpanId: llmSpanRef, name, kind: 'tool',
                status: 'ok', startTime: toolStart, endTime: new Date().toISOString(),
                input: args, output: result2 ?? null, attributes,
              });
              // JSON.stringify(undefined) returns the JS value `undefined`, not a string — coalesce
              // to the literal "null" so a void-returning tool still produces a valid tool message.
              const content = typeof result2 === 'string' ? result2 : (JSON.stringify(result2) ?? 'null');
              return { role: 'tool', tool_call_id: call.id, content };
            },
            (err) => {
              toolSpans.push({
                spanId: toolSpanId, parentSpanId: llmSpanRef, name, kind: 'tool',
                status: 'error', startTime: toolStart, endTime: new Date().toISOString(),
                input: args, attributes, error: err instanceof Error ? err.message : String(err),
              });
              throw err;
            },
          );
        }),
      );

      const failure = settled.find((s) => s.status === 'rejected');
      if (failure) {
        this._reportToolSpans(traceEnabled, traceId, traceName, traceConf.sessionId, toolSpans);
        throw (failure as PromiseRejectedResult).reason;
      }

      const toolMsgs = settled.map((s) => (s as PromiseFulfilledResult<Message>).value);
      messages = [...messages, result.message, ...toolMsgs];
    }

    this._reportToolSpans(traceEnabled, traceId, traceName, traceConf.sessionId, toolSpans);
    return { content: '', messages, iterations: max, stoppedAtLimit: true, traceId };
  }

  /**
   * @internal Appends runToolLoop's `tool` spans onto the shared trace the `llm` spans
   * already live in — created by the gateway on the gateway path, or by this loop's own
   * per-round `llm` span report on the BYO path. No-op when tracing is disabled or no
   * tool ran.
   *
   * Enqueued rather than awaited, so the loop's result is not held up by its own
   * telemetry; the queue drains it on the next turn of the event loop. Synchronous, and
   * kept `void`-returning rather than made `async`, so every call site reads as the
   * non-blocking hand-off it now is.
   */
  private _reportToolSpans(
    traceEnabled: boolean,
    traceId: string | undefined,
    name: string,
    sessionId: string | undefined,
    spans: IngestSpan[],
  ): void {
    if (!traceEnabled || spans.length === 0) return;
    this.spanQueue.enqueue({ traceId, name, sessionId, spans });
  }

  /**
   * Attaches feedback (rating and/or label and/or comment) to a trace, or to one span
   * within it. Wraps `POST /traces/:id/feedback`.
   *
   * @param input - The traceId plus at least one of rating/label/comment; `spanId` scopes
   *   it to one span instead of the whole trace.
   * @returns The created feedback row.
   * @throws {acruxcoreError} API_ERROR for a non-2xx response (e.g. 400 validation, 404 unknown trace).
   */
  async submitFeedback(input: FeedbackInput): Promise<FeedbackResult> {
    const { traceId, ...body } = input;
    const response = await this._request('POST', `/traces/${encodeURIComponent(traceId)}/feedback`, body, 'submitting feedback');
    return this._parseJsonOrThrow(response, 'submitting feedback') as Promise<FeedbackResult>;
  }

  /**
   * Edits a feedback row's rating/label/comment in place. Only the row's original author
   * may edit it. Wraps `PATCH /traces/:id/feedback/:feedbackId`.
   *
   * @param input - traceId, feedbackId, and the fields to change (omit a field to keep it,
   *   pass `null` to clear it).
   * @returns The updated feedback row.
   * @throws {acruxcoreError} API_ERROR for a non-2xx response (e.g. 403 not the author, 404 unknown).
   */
  async updateFeedback(input: FeedbackUpdateInput): Promise<FeedbackResult> {
    const { traceId, feedbackId, ...body } = input;
    const response = await this._request(
      'PATCH',
      `/traces/${encodeURIComponent(traceId)}/feedback/${encodeURIComponent(feedbackId)}`,
      body,
      'updating feedback',
    );
    return this._parseJsonOrThrow(response, 'updating feedback') as Promise<FeedbackResult>;
  }

  /**
   * Reads back a full trace: its header plus every span assembled into a parent/child tree.
   * Wraps `GET /traces/:id`.
   *
   * @param traceId - The trace id (returned by `trace()`, or minted by the gateway).
   * @returns The trace header and its span tree.
   * @throws {acruxcoreError} API_ERROR with statusCode 404 if the trace doesn't exist (or
   *   belongs to another team).
   */
  async getTrace(traceId: string): Promise<GetTraceResult> {
    const response = await this._request('GET', `/traces/${encodeURIComponent(traceId)}`, undefined, 'reading trace');
    return this._parseJsonOrThrow(response, 'reading trace') as Promise<GetTraceResult>;
  }

  /**
   * Lists traces, newest first, with optional filters. Wraps `GET /traces`.
   *
   * @param options - Optional filters (status, model, sessionId, date range, thresholds, free-text) and pagination.
   * @returns One page of trace summaries.
   * @throws {acruxcoreError} On a non-2xx response.
   */
  async listTraces(options: ListTracesOptions = {}): Promise<ListTracesResult> {
    const params = new URLSearchParams();
    if (options.from) params.set('from', options.from);
    if (options.to) params.set('to', options.to);
    if (options.status) params.set('status', options.status);
    if (options.model) params.set('model', options.model);
    if (options.sessionId) params.set('session_id', options.sessionId);
    if (options.promptVersionId) params.set('prompt_version_id', options.promptVersionId);
    if (options.minLatencyMs !== undefined) params.set('min_latency_ms', String(options.minLatencyMs));
    if (options.minCostUsd !== undefined) params.set('min_cost_usd', String(options.minCostUsd));
    if (options.minTokens !== undefined) params.set('min_tokens', String(options.minTokens));
    if (options.q) params.set('q', options.q);
    if (options.page !== undefined) params.set('page', String(options.page));
    if (options.limit !== undefined) params.set('limit', String(options.limit));

    const qs = params.toString();
    const response = await this._request('GET', `/traces${qs ? `?${qs}` : ''}`, undefined, 'listing traces');
    return this._parseJsonOrThrow(response, 'listing traces') as Promise<ListTracesResult>;
  }
}
