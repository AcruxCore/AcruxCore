import { randomUUID } from 'node:crypto';
import { acruxcoreError } from './error';
import { fetchWithRetry } from './fetch';
import { parseToolArgs, resolveParametersSchema } from './tools';
import { inferProviderName } from './provider';
import { resolveResponseFormat } from './responseFormat';
import type { GatewayNamespaceHost } from './host';
import type {
  Message,
  TraceInput,
  IngestSpan,
  ChatOptions,
  ChatResult,
  ChatChunk,
  ChatUsage,
  GatewayCallMeta,
  ResolvedTool,
  RunToolLoopOptions,
  RunToolLoopResult,
  ResponseFormat,
  ToolCall,
  ToolDefinition,
} from './types';

// ── Module-level helpers (moved from client.ts) ──

/**
 * True for a loopback host (`localhost`, `127.0.0.1`, `::1`) — legitimate to
 * reach over plain HTTP during local development.
 */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/**
 * URLs already warned about, so the check can run per call while still logging
 * at most one line per distinct URL.
 */
const warnedCleartextUrls = new Set<string>();

/**
 * Warns, once per URL, when an Authorization-bearing request is about to travel
 * over cleartext HTTP to a non-loopback host.
 */
export function warnIfCleartextUrl(url: string, what: string): void {
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
 * Live clients that may still have spans to send, held weakly so an abandoned
 * client can still be collected.
 */
const clientsAwaitingExitFlush = new Set<WeakRef<GatewayNamespace>>();

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
 * Enrols a gateway namespace in the shared exit flush, attaching the listener
 * on first use.
 */
function registerExitFlush(ref: WeakRef<GatewayNamespace>): void {
  if (typeof process === 'undefined' || typeof process.on !== 'function') return;
  clientsAwaitingExitFlush.add(ref);
  if (beforeExitListener) return;
  beforeExitListener = () => {
    detachExitListener();
    for (const candidate of clientsAwaitingExitFlush) {
      const gw = candidate.deref();
      if (gw) void gw.flush();
      else clientsAwaitingExitFlush.delete(candidate);
    }
  };
  process.on('beforeExit', beforeExitListener);
}

/**
 * Removes a gateway namespace from the shared exit flush.
 */
function unregisterExitFlush(ref: WeakRef<GatewayNamespace>): void {
  clientsAwaitingExitFlush.delete(ref);
  if (clientsAwaitingExitFlush.size === 0) detachExitListener();
}

/**
 * How one tool name gets executed during a loop.
 */
interface ToolRoute {
  kind: 'local' | 'http' | 'dispatch';
  tool?: import('./tools').AcruxTool<never>;
  toolId?: string;
  alias?: string;
  toolVersionId?: string;
}

// ── GatewayNamespace ──

/**
 * Gateway, BYO-provider, and tool-loop operations, reached as `hub.gateway`.
 *
 * This namespace owns every method that talks to the gateway or a BYO provider:
 * `chat()`, `stream()`, `runToolLoop()`, `flush()`, and `close()`. It also
 * manages the span queue and the process-exit flush hook.
 */
export class GatewayNamespace {
  private readonly host: GatewayNamespaceHost;
  /** This namespace's entry in the shared exit-flush registry. */
  private readonly exitRef: WeakRef<GatewayNamespace> = new WeakRef(this);

  constructor(host: GatewayNamespaceHost) {
    this.host = host;
    registerExitFlush(this.exitRef);
  }

  // ── Public API ──

  /**
   * Waits until every trace this client reported in the background has been sent.
   *
   * `chat()`, streaming `chat()` and `runToolLoop()` hand back their result without
   * waiting for the trace write, so call this before reading the traces API back — in a
   * test, or in code that polls for the span it just produced. A script that simply
   * returns from `main()` does not need it: the SDK flushes as the process winds down.
   */
  async flush(): Promise<void> {
    await this.host.spanQueue.flush();
  }

  /**
   * Flushes pending traces, then stops accepting new ones and releases the
   * exit hook. Idempotent.
   */
  async close(): Promise<void> {
    unregisterExitFlush(this.exitRef);
    await this.host.spanQueue.close();
  }

  /**
   * Calls the gateway's `POST /gateway/chat/completions` by default — a single
   * request/response, no tool-dispatch loop. If `options.provider` is set (or,
   * absent that, the client's own `config.provider` default), this instead calls
   * that BYO provider's `baseUrl` directly, skipping the gateway entirely.
   */
  async chat(options: ChatOptions & { stream: true }): Promise<AsyncGenerator<ChatChunk>>;
  async chat(options: ChatOptions & { stream?: false | undefined }): Promise<ChatResult>;
  async chat(options: ChatOptions): Promise<ChatResult | AsyncGenerator<ChatChunk>> {
    options.responseFormat = await resolveResponseFormat(options.responseFormat) as ChatOptions['responseFormat'];
    const providerConfig = options.provider ?? this.host.providerDefault;

    const traceOpt = options.trace ?? Boolean(providerConfig);
    const traceEnabled = traceOpt !== false;
    const traceConf = typeof traceOpt === 'object' ? traceOpt : {};

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
      const spanId = providerConfig
        ? (result.gateway.spanRef ?? `chat-${randomUUID()}`)
        : `chat-${randomUUID()}`;
      const traceId = traceConf.traceId ?? result.gateway.traceId ?? undefined;
      this.host.spanQueue.enqueue({
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
   * Same call as `chat()`, forced into streaming mode — returns an async
   * iterable of {@link ChatChunk} instead of requiring `{ stream: true }` on
   * the options object.
   */
  async stream(options: Omit<ChatOptions, 'stream'>): Promise<AsyncGenerator<ChatChunk>> {
    return this.chat({ ...options, stream: true });
  }

  /**
   * Runs the full tool-calling loop against the gateway: calls the model, runs
   * whatever tools it asks for, appends the results, and repeats until the model
   * stops calling tools or `maxIterations` is reached.
   */
  async runToolLoop(options: RunToolLoopOptions): Promise<RunToolLoopResult> {
    options.responseFormat = await resolveResponseFormat(options.responseFormat) as RunToolLoopOptions['responseFormat'];
    const hasTools =
      (options.tools?.length ?? 0) + (options.toolDefs?.length ?? 0) + (options.toolRefs?.length ?? 0) > 0;
    const shaping = !!options.responseFormat && hasTools;

    const gathered = await this._runToolLoopGather(options, shaping ? undefined : options.responseFormat, undefined);
    if (!shaping) return gathered;

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
      stoppedAtLimit: shaped.stoppedAtLimit,
      traceId: gathered.traceId ?? shaped.traceId,
    };
  }

  // ── Private helpers ──

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

  /** @internal One non-streaming gateway completion. */
  private async _completeOnce(options: ChatOptions, extraHeaders?: Record<string, string>): Promise<ChatResult> {
    const body = this._buildChatBody(options);
    const response = await this.host._request('POST', '/gateway/chat/completions', body, 'calling chat completions', extraHeaders);
    const gateway = this._readGatewayMeta(response);
    const data = (await this.host._parseJsonOrThrow(response, 'calling chat completions')) as {
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

  /** @internal One non-streaming completion sent DIRECTLY to a BYO provider. */
  private async _completeViaProvider(
    options: ChatOptions,
    providerConfig: import('./types').ProviderConfig,
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
        this.host.maxRetries,
        this.host.retryInterval,
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

  /** @internal Streams gateway SSE and yields one ChatChunk per frame. */
  private async *_streamChat(body: Record<string, unknown>, extraHeaders?: Record<string, string>): AsyncGenerator<ChatChunk> {
    const response = await this.host._request('POST', '/gateway/chat/completions', body, 'streaming chat completions', extraHeaders);
    if (!response.ok) {
      await this.host._parseJsonOrThrow(response, 'streaming chat completions');
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

  /** @internal Streams a BYO provider's SSE directly — never through the gateway. */
  private async *_streamViaProvider(
    options: ChatOptions,
    providerConfig: import('./types').ProviderConfig,
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
        this.host.maxRetries,
        this.host.retryInterval,
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
    const toolCallParts = new Map<number, { id: string; name: string; arguments: string }>();

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
      this.host.spanQueue.enqueue({
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
          ...(finishReason ? { attributes: { finishReason } } : {}),
        }],
      });
    }
  }

  /** @internal Reconciles and resolves once, returning the route table and refs. */
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

    for (const t of options.tools ?? []) {
      const { isAcruxTool } = await import('./tools');
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
        const result = await this.host.tools.syncOne(t);
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

    const callerRefs = options.toolRefs ?? [];
    if (callerRefs.length > 0) {
      const resolved: ResolvedTool[] = await this.host.tools.resolve(callerRefs);
      callerRefs.forEach((ref, index) => {
        const item = resolved[index];
        if (!item) return;
        const name = item.function.name;
        const versionId = `${item.toolId}:${item.versionNumber}`;
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

  /** @internal The gather loop shared by runToolLoop's two phases. */
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
    const providerConfig = options.provider ?? this.host.providerDefault;
    const byoToolSchemas = providerConfig && ([...(options.toolDefs ?? []), ...inlinedSchemas].length > 0)
      ? [...(options.toolDefs ?? []), ...inlinedSchemas]
      : undefined;

    let messages: Message[] = [...options.messages];
    const toolSpans: IngestSpan[] = [];
    let traceId: string | undefined = seedTraceId ?? traceConf.traceId;

    for (let i = 0; i < max; i++) {
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
              toolRefs: effectiveRefs.length > 0 ? effectiveRefs : undefined,
              temperature: options.temperature,
              maxTokens: options.maxTokens,
              responseFormat: effectiveResponseFormat,
            },
            extraHeaders,
          );

      if (traceEnabled && !traceId) traceId = result.gateway.traceId ?? undefined;
      const llmSpanRef = result.gateway.spanRef ?? undefined;

      if (providerConfig && traceEnabled) {
        const llmSpanId = result.gateway.spanRef ?? `llm-${i}`;
        const llmSpan: IngestSpan = {
          spanId: llmSpanId,
          name: result.model,
          kind: 'llm',
          status: 'ok',
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
        const mustAwaitTraceOpen = i === 0 && [...routes.values()].some((r) => r.kind === 'http');
        if (mustAwaitTraceOpen) {
          try {
            await this.host._request('POST', '/traces', { traces: [roundTrace] }, 'reporting llm span');
          } catch (err) {
            console.warn('[acruxcore] runToolLoop llm-span report failed — continuing without it', err instanceof Error ? err.message : err);
          }
        } else {
          this.host.spanQueue.enqueue(roundTrace);
        }
      }

      const calls = result.message.tool_calls ?? [];
      if (result.finishReason !== 'tool_calls' || calls.length === 0) {
        this._reportToolSpans(traceEnabled, traceId, traceName, traceConf.sessionId, toolSpans);
        return { content: result.content ?? '', messages: [...messages, result.message], iterations: i + 1, stoppedAtLimit: false, traceId };
      }

      const settled = await Promise.allSettled(
        calls.map(async (call, callIndex): Promise<Message> => {
          const name = call.function.name;
          let args: Record<string, unknown> = {};
          try { const p = JSON.parse(call.function.arguments || '{}'); if (p && typeof p === 'object') args = p as Record<string, unknown>; } catch { /* keep {} */ }

          const route = routes.get(name);

          if (route?.kind === 'http') {
            const executed = await this.host.tools.execute(route.toolId ?? '', args, {
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
          const attributes: Record<string, unknown> = {
            arguments: args,
            executorType: 'client',
            ...(route?.toolVersionId ? { toolVersionId: route.toolVersionId } : {}),
          };
          return Promise.resolve(run()).then(
            (result2): Message => {
              toolSpans.push({
                spanId: toolSpanId, parentSpanId: llmSpanRef, name, kind: 'tool',
                status: 'ok', startTime: toolStart, endTime: new Date().toISOString(),
                input: args, output: result2 ?? null, attributes,
              });
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

  /** @internal Reports tool spans onto the shared trace. */
  private _reportToolSpans(
    traceEnabled: boolean,
    traceId: string | undefined,
    name: string,
    sessionId: string | undefined,
    spans: IngestSpan[],
  ): void {
    if (!traceEnabled || spans.length === 0) return;
    this.host.spanQueue.enqueue({ traceId, name, sessionId, spans });
  }
}
