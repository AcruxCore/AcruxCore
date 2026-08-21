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
  ToolLoopEvent,
  ToolRef,
  RenderResult,
  RunPromptWithToolsOptions,
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
  kind: 'local' | 'client' | 'http' | 'dispatch';
  tool?: import('./tools').AcruxTool<never>;
  /** Set on a `client` route: the function supplied in `clientTools`. */
  fn?: (args: Record<string, unknown>) => Promise<unknown> | unknown;
  toolId?: string;
  alias?: string;
  /** Set instead of `alias` when the ref pinned one exact version. */
  versionNumber?: number;
  toolVersionId?: string;
}

/** One streamed tool-loop round, as `_streamOneRound` hands it back to the loop. */
interface StreamedRound {
  /** The assembled assistant turn — text plus any tool calls the model asked for. */
  message?: Message;
  finishReason?: string | null;
  /** The round's `llm` span, which its tool spans parent onto. */
  spanRef?: string;
}

/**
 * One BYO-provider streamed turn, assembled as the stream runs and complete once it
 * ends. Handed back by `_streamRoundViaProvider` so its caller decides what span to
 * write from it.
 */
interface ByoStreamState {
  startTime?: string;
  content?: string;
  model?: string;
  usage?: ChatUsage;
  finishReason?: string | null;
  toolCalls?: ToolCall[];
}

/**
 * Parses one tool call's `arguments` JSON string into an object.
 *
 * A model that emits malformed or non-object arguments gets `{}` rather than an
 * exception: the tool then fails (or not) on its own terms, which reads far better than
 * a JSON error from inside the SDK.
 */
function parseCallArguments(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
        : this._streamChat(this._buildChatBody(options, true), traceHeaders);
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
   *
   * With `stream: true` it returns an async iterable of {@link ToolLoopEvent} instead,
   * so a UI can show text as it arrives and render a running tool as its own state. The
   * trace is identical either way.
   */
  async runToolLoop(options: RunToolLoopOptions & { stream: true }): Promise<AsyncGenerator<ToolLoopEvent>>;
  async runToolLoop(options: RunToolLoopOptions & { stream?: false | undefined }): Promise<RunToolLoopResult>;
  async runToolLoop(options: RunToolLoopOptions): Promise<RunToolLoopResult | AsyncGenerator<ToolLoopEvent>>;
  async runToolLoop(options: RunToolLoopOptions): Promise<RunToolLoopResult | AsyncGenerator<ToolLoopEvent>> {
    options.responseFormat = await resolveResponseFormat(options.responseFormat) as RunToolLoopOptions['responseFormat'];
    if (options.stream) return this._runToolLoopStream(options);
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

  /**
   * Runs a rendered prompt's own tools in the loop — the two-line way:
   *
   * ```ts
   * const r = await hub.prompts.render('weather-brief', 'staging', { city: 'Lisbon' });
   * const result = await hub.gateway.runPromptWithTools(r);
   * ```
   *
   * Everything the loop needs is already in the render result, so nothing is restated at
   * the call site: the model comes from the prompt version's bound model, the messages
   * from the render, the tools from the prompt's bindings, and `promptVersionId` from the
   * resolved version — that last one is the easy one to forget by hand, and forgetting it
   * costs trace lineage silently, since the call still works.
   *
   * A binding pinned to an exact tool version travels as a pin, not as its alias, so a
   * pinned prompt keeps running the build it was pinned to.
   *
   * Every option is optional and wins over the derived value when passed, so
   * `runPromptWithTools(r, { model: 'gpt-4o-mini' })` overrides the bound model. The rest
   * pass straight through to {@link runToolLoop}, `stream: true` included.
   *
   * **A prompt with no tools bound still runs**, as a plain completion — the name reads
   * slightly wrong there, but erroring would fail an unconfigured prompt for no reason.
   *
   * @param rendered - A {@link RenderResult} from `hub.prompts.render`.
   * @param options - Anything {@link runToolLoop} takes; each value overrides the derived
   *   one. `toolRefs: []` runs the prompt with no tools at all.
   * @returns The loop's result, or an event stream when `stream: true`.
   * @throws {acruxcoreError} `VALIDATION_ERROR` when the prompt version has no bound model
   *   and no `model` was passed; `MISSING_DISPATCH` when a bound tool has a `client`
   *   executor and nothing was given to run it.
   */
  async runPromptWithTools(
    rendered: RenderResult,
    options: RunPromptWithToolsOptions & { stream: true },
  ): Promise<AsyncGenerator<ToolLoopEvent>>;
  async runPromptWithTools(
    rendered: RenderResult,
    options?: RunPromptWithToolsOptions & { stream?: false | undefined },
  ): Promise<RunToolLoopResult>;
  async runPromptWithTools(
    rendered: RenderResult,
    options: RunPromptWithToolsOptions = {},
  ): Promise<RunToolLoopResult | AsyncGenerator<ToolLoopEvent>> {
    const model = options.model ?? rendered.model;
    if (!model) {
      throw new acruxcoreError(
        'acruxcore: this prompt version has no bound model, so there is nothing to run it ' +
          'on. Either bind a default model on the prompt version, or pass model to ' +
          'runPromptWithTools().',
        'VALIDATION_ERROR',
      );
    }

    const derivedRefs: ToolRef[] = rendered.toolResolutions.map((r) =>
      r.pinnedVersionNumber !== undefined
        ? { name: r.name, version: r.pinnedVersionNumber }
        : r.alias
          ? { name: r.name, alias: r.alias }
          : { name: r.name },
    );

    return this.runToolLoop({
      ...options,
      model,
      messages: options.messages ?? rendered.messages,
      toolRefs: options.toolRefs ?? derivedRefs,
      promptVersionId: options.promptVersionId ?? rendered.versionId ?? undefined,
    });
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

  /**
   * @internal Builds the JSON body shared by chat() and runToolLoop()'s gateway calls.
   *
   * `forGateway` gates one field: `prompt_version_id` is ours, not OpenAI's, so sending
   * it to a BYO provider would be sending a stranger a field it never asked for. On a BYO
   * call the SDK writes the span itself and stamps the lineage there instead.
   */
  private _buildChatBody(options: ChatOptions, forGateway = false): Record<string, unknown> {
    const body: Record<string, unknown> = { model: options.model, messages: options.messages };
    if (forGateway && options.promptVersionId) body['prompt_version_id'] = options.promptVersionId;
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
    const body = this._buildChatBody(options, true);
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

  /**
   * @internal Streams gateway SSE and yields one ChatChunk per frame.
   *
   * `metaOut`, when given, is filled with the response's `x-gateway-*` metadata before
   * the first chunk is yielded. The streaming tool loop needs it that early: the trace id
   * it threads through the following rounds comes off these headers.
   */
  private async *_streamChat(
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
    metaOut?: { gateway?: GatewayCallMeta },
  ): AsyncGenerator<ChatChunk> {
    const response = await this.host._request('POST', '/gateway/chat/completions', body, 'streaming chat completions', extraHeaders);
    if (!response.ok) {
      await this.host._parseJsonOrThrow(response, 'streaming chat completions');
      return;
    }
    if (!response.body) {
      throw new acruxcoreError('acruxcore: streaming response had no body', 'NETWORK_ERROR');
    }
    if (metaOut) metaOut.gateway = this._readGatewayMeta(response);

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
            choices: { delta: ChatChunk['delta']; finish_reason: string | null }[];
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
   * @internal Streams ONE completion straight from a BYO provider, yielding raw chunks.
   *
   * Shared by the public BYO stream and the streaming tool loop, which need the same wire
   * handling but file different spans — so the accumulated turn is handed back through
   * `state` instead of being written to a span here.
   */
  private async *_streamRoundViaProvider(
    options: ChatOptions,
    providerConfig: import('./types').ProviderConfig,
    state: ByoStreamState,
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
            choices?: { delta: ChatChunk['delta']; finish_reason: string | null }[];
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

    state.startTime = startTime;
    state.content = accumulatedContent;
    state.model = finalModel;
    state.usage = usage;
    state.finishReason = finishReason;
    state.toolCalls = [...toolCallParts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, p]) => ({ id: p.id, type: 'function' as const, function: { name: p.name, arguments: p.arguments } }));
  }

  /**
   * @internal Streams a BYO provider's SSE directly — never through the gateway — then
   * files the one `llm` span for it.
   *
   * The gateway is bypassed, so nothing server-side records this call; the client writes
   * the span itself once the stream has ended and the turn is fully assembled.
   */
  private async *_streamViaProvider(
    options: ChatOptions,
    providerConfig: import('./types').ProviderConfig,
  ): AsyncGenerator<ChatChunk> {
    const state: ByoStreamState = {};
    yield* this._streamRoundViaProvider(options, providerConfig, state);

    const traceOpt = options.trace ?? true;
    if (traceOpt !== false) {
      const traceConf = typeof traceOpt === 'object' ? traceOpt : {};
      this.host.spanQueue.enqueue({
        traceId: traceConf.traceId,
        sessionId: traceConf.sessionId,
        name: 'chat',
        spans: [
          this._byoLlmSpan(state, options.messages, providerConfig, options.promptVersionId, randomUUID()),
        ],
      });
    }
  }

  /**
   * @internal Builds the `llm` span for one streamed BYO-provider turn.
   *
   * Shared by the public BYO stream and the streaming tool loop so a streamed turn
   * records the same span either way — the failure mode this avoids is streaming silently
   * costing observability.
   */
  private _byoLlmSpan(
    state: ByoStreamState,
    messages: Message[],
    providerConfig: import('./types').ProviderConfig,
    promptVersionId: string | undefined,
    spanId: string,
  ): IngestSpan {
    const toolCalls = state.toolCalls ?? [];
    const model = state.model ?? '';
    return {
      spanId,
      name: model,
      kind: 'llm',
      status: 'ok',
      startTime: state.startTime ?? new Date().toISOString(),
      endTime: new Date().toISOString(),
      model,
      provider: inferProviderName(providerConfig.baseUrl),
      usage: state.usage,
      promptVersionId,
      input: { messages },
      output: {
        role: 'assistant',
        content: state.content ?? '',
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      ...(state.finishReason ? { attributes: { finishReason: state.finishReason } } : {}),
    };
  }

  /** @internal Reconciles and resolves once, returning the route table and refs. */
  private async _prepareToolRoutes(
    options: RunToolLoopOptions,
  ): Promise<{
    routes: Map<string, ToolRoute>;
    refs: ToolRef[];
    inlinedSchemas: ToolDefinition[];
  }> {
    const routes = new Map<string, ToolRoute>();
    const refs: ToolRef[] = [];
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
        const supplied = options.clientTools?.[name];
        if (item.executorType === 'http') {
          // An entry in clientTools for an http tool is ignored, not flagged: the platform
          // runs the tool, and one map is expected to serve aliases whose executor differs
          // — production http, staging client — so warning here would fire on every
          // correct run of a two-alias script.
          routes.set(name, {
            kind: 'http',
            toolId: item.toolId,
            alias: ref.alias,
            versionNumber: ref.version,
            toolVersionId: versionId,
          });
        } else if (supplied) {
          // A locally-run route whose definition and version stamp stay the catalog's —
          // unlike tools: [...], which commits a new version and drops the binding's pin.
          routes.set(name, {
            kind: 'client',
            fn: supplied,
            alias: ref.alias,
            versionNumber: ref.version,
            toolVersionId: versionId,
          });
        } else if (options.dispatch) {
          routes.set(name, {
            kind: 'dispatch',
            alias: ref.alias,
            versionNumber: ref.version,
            toolVersionId: versionId,
          });
        } else {
          // Naming the keys that *were* supplied turns a typo'd key from a puzzle into a
          // one-second fix.
          const held = options.clientTools
            ? ` clientTools held: [${Object.keys(options.clientTools)
                .sort()
                .map((k) => `'${k}'`)
                .join(', ')}].`
            : '';
          throw new acruxcoreError(
            `acruxcore: tool '${name}' has a client executor, so something has to run it, but ` +
              `no implementation was supplied. Pass it in clientTools: { ${name} }, or pass ` +
              `dispatch.${held}`,
            'MISSING_DISPATCH',
          );
        }
        refs.push({
          name,
          ...(ref.alias ? { alias: ref.alias } : {}),
          ...(ref.version !== undefined ? { version: ref.version } : {}),
        });
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
              promptVersionId: options.promptVersionId,
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
        calls.map((call, callIndex) =>
          this._dispatchToolCall(call, {
            callIndex,
            roundIndex: i,
            routes,
            dispatch: options.dispatch,
            traceEnabled,
            traceId,
            llmSpanRef,
            toolSpans,
          }),
        ),
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
   * @internal The streaming twin of `_runToolLoopGather`, as an event generator.
   *
   * Same rounds, same routing, same spans — the only difference is that each round's
   * completion is streamed, so model text can be forwarded while the round is still
   * running. Tool calls go through `_dispatchToolCall`, the one place either loop runs a
   * tool.
   */
  private async *_runToolLoopStream(options: RunToolLoopOptions): AsyncGenerator<ToolLoopEvent> {
    const { routes, refs: effectiveRefs, inlinedSchemas } = await this._prepareToolRoutes(options);
    const providerConfig = options.provider ?? this.host.providerDefault;
    const byoToolSchemas = providerConfig && [...(options.toolDefs ?? []), ...inlinedSchemas].length > 0
      ? [...(options.toolDefs ?? []), ...inlinedSchemas]
      : undefined;

    // With tools AND a responseFormat, the gathered answer is re-asked for as JSON in a
    // final round (the gateway rejects both on one request). Only that round's text is the
    // answer, so the gather rounds' prose is not forwarded — a caller who asked for JSON
    // should not be handed the prose draft first.
    const hasTools = routes.size > 0 || (options.toolDefs?.length ?? 0) > 0;
    const shaping = Boolean(options.responseFormat) && hasTools;

    const max = options.maxIterations ?? 10;
    const traceOpt = options.trace ?? true;
    const traceEnabled = traceOpt !== false;
    const traceConf = typeof traceOpt === 'object' ? traceOpt : {};
    const traceName = traceConf.name ?? 'runToolLoop';

    let messages: Message[] = [...options.messages];
    const toolSpans: IngestSpan[] = [];
    const state: { traceId?: string } = { traceId: traceConf.traceId };
    let gathered: RunToolLoopResult | undefined;

    for (let i = 0; i < max; i++) {
      const round: StreamedRound = {};
      yield* this._streamOneRound({
        options,
        convo: messages,
        roundIndex: i,
        emitContent: !shaping,
        effectiveRefs,
        byoToolSchemas,
        responseFormat: shaping ? undefined : options.responseFormat,
        providerConfig,
        traceEnabled,
        traceConf,
        traceName,
        state,
        out: round,
      });

      const message = round.message as Message;
      const calls = message.tool_calls ?? [];

      if (round.finishReason !== 'tool_calls' || calls.length === 0) {
        gathered = {
          content: message.content ?? '',
          messages: [...messages, message],
          iterations: i + 1,
          stoppedAtLimit: false,
          traceId: state.traceId,
        };
        break;
      }

      for (const call of calls) {
        yield {
          type: 'tool_call',
          id: call.id,
          name: call.function.name,
          arguments: parseCallArguments(call),
          round: i,
        };
      }

      // Every call reports back the moment it settles, so a slow tool cannot hold back a
      // fast one's `tool_result` event.
      const outcomes = new Map<string, { result?: unknown; error?: string }>();
      const tasks = calls.map((call, callIndex) =>
        this._dispatchToolCall(call, {
          callIndex,
          roundIndex: i,
          routes,
          dispatch: options.dispatch,
          traceEnabled,
          traceId: state.traceId,
          llmSpanRef: round.spanRef,
          toolSpans,
          onSettled: (id, _name, result, error) => outcomes.set(id, { result, error }),
        }),
      );
      // Resolving with the call's own index either way is what guarantees exactly one
      // report per call — including for a tool that throws before it ever runs, which
      // never reaches `onSettled`.
      const remaining = new Map<number, Promise<number>>(
        tasks.map((task, index) => [
          index,
          task.then(
            () => index,
            (err) => {
              const id = calls[index]!.id;
              if (!outcomes.has(id)) {
                outcomes.set(id, { error: err instanceof Error ? err.message : String(err) });
              }
              return index;
            },
          ),
        ]),
      );

      while (remaining.size > 0) {
        const index = await Promise.race(remaining.values());
        remaining.delete(index);
        const call = calls[index]!;
        const outcome = outcomes.get(call.id) ?? {};
        yield {
          type: 'tool_result',
          id: call.id,
          name: call.function.name,
          result: outcome.result,
          error: outcome.error,
          round: i,
        };
      }

      const results = await Promise.allSettled(tasks);
      const failure = results.find((r) => r.status === 'rejected');
      if (failure) {
        this._reportToolSpans(traceEnabled, state.traceId, traceName, traceConf.sessionId, toolSpans);
        throw (failure as PromiseRejectedResult).reason;
      }
      messages = [
        ...messages,
        message,
        ...results.map((r) => (r as PromiseFulfilledResult<Message>).value),
      ];
    }

    gathered ??= {
      content: '',
      messages,
      iterations: max,
      stoppedAtLimit: true,
      traceId: state.traceId,
    };

    this._reportToolSpans(traceEnabled, state.traceId, traceName, traceConf.sessionId, toolSpans);

    if (!shaping) {
      yield { type: 'done', result: gathered };
      return;
    }

    // ── shaping round: same nudge as the blocking loop, streamed ──
    const shapeNudge = 'Produce your final response now, as the JSON object defined by the response schema.';
    let shapeMessages = gathered.messages.slice();
    const last = shapeMessages[shapeMessages.length - 1];
    if (last && last.role === 'assistant' && !last.tool_calls) shapeMessages = shapeMessages.slice(0, -1);
    shapeMessages.push({ role: 'user', content: shapeNudge });

    const shapeRound: StreamedRound = {};
    yield* this._streamOneRound({
      options,
      convo: shapeMessages,
      roundIndex: gathered.iterations,
      emitContent: true,
      effectiveRefs: [],
      byoToolSchemas: undefined,
      responseFormat: options.responseFormat,
      providerConfig,
      traceEnabled,
      traceConf,
      traceName,
      state,
      out: shapeRound,
    });

    const shaped = shapeRound.message as Message;
    yield {
      type: 'done',
      result: {
        content: shaped.content ?? '',
        messages: [...gathered.messages, { role: 'user', content: shapeNudge }, shaped],
        iterations: gathered.iterations,
        stoppedAtLimit: gathered.stoppedAtLimit,
        traceId: state.traceId,
      },
    };
  }

  /**
   * @internal Streams one round of a tool loop, yielding its `content` events.
   *
   * Fills `out` with the assembled assistant turn, its `finishReason`, and the round's
   * `llm` span ref (which its tool spans parent onto), and seeds `state.traceId` on the
   * first round so every later round joins the same trace.
   */
  private async *_streamOneRound(args: {
    options: RunToolLoopOptions;
    convo: Message[];
    roundIndex: number;
    /** `false` accumulates the round's text without forwarding it, for a shaping run's gather rounds. */
    emitContent: boolean;
    effectiveRefs: ToolRef[];
    byoToolSchemas: ToolDefinition[] | undefined;
    responseFormat: ResponseFormat | undefined;
    providerConfig: import('./types').ProviderConfig | undefined;
    traceEnabled: boolean;
    traceConf: { traceId?: string; sessionId?: string; tags?: string[]; metadata?: Record<string, unknown> };
    traceName: string;
    state: { traceId?: string };
    out: StreamedRound;
  }): AsyncGenerator<ToolLoopEvent> {
    const { options, convo, roundIndex, emitContent, providerConfig, traceEnabled, traceConf, state, out } = args;

    const chatOptions: ChatOptions = {
      model: options.model,
      messages: convo,
      tools: providerConfig ? args.byoToolSchemas : (options.toolDefs?.length ? options.toolDefs : undefined),
      toolRefs: providerConfig ? undefined : (args.effectiveRefs.length > 0 ? args.effectiveRefs : undefined),
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      responseFormat: args.responseFormat,
      promptVersionId: options.promptVersionId,
      stream: true,
    };

    const contentParts: string[] = [];
    const toolCallParts = new Map<number, { id: string; name: string; arguments: string }>();
    let finishReason: string | null = null;

    /** Folds one chunk into the round's accumulators and returns its new text, if any. */
    const take = (chunk: ChatChunk): string | undefined => {
      if (chunk.finishReason) finishReason = chunk.finishReason;
      for (const tc of chunk.delta.tool_calls ?? []) {
        const key = tc.index ?? 0;
        const part = toolCallParts.get(key) ?? { id: '', name: '', arguments: '' };
        if (tc.id) part.id = tc.id;
        if (tc.function?.name) part.name = tc.function.name;
        if (tc.function?.arguments) part.arguments += tc.function.arguments;
        toolCallParts.set(key, part);
      }
      const text = chunk.delta.content;
      if (text) contentParts.push(text);
      return text;
    };

    if (providerConfig) {
      const byoState: ByoStreamState = {};
      for await (const chunk of this._streamRoundViaProvider(chatOptions, providerConfig, byoState)) {
        const text = take(chunk);
        if (text && emitContent) yield { type: 'content', delta: text, round: roundIndex };
      }

      // No gateway on this path, so nothing server-side recorded the round — the client
      // writes its `llm` span itself, exactly as the blocking BYO loop does.
      state.traceId ??= randomUUID();
      out.spanRef = randomUUID();
      if (traceEnabled) {
        this.host.spanQueue.enqueue({
          traceId: state.traceId,
          sessionId: traceConf.sessionId,
          name: args.traceName,
          spans: [
            this._byoLlmSpan(byoState, convo, providerConfig, options.promptVersionId, out.spanRef),
          ],
        });
      }
    } else {
      const extraHeaders: Record<string, string> | undefined = traceEnabled
        ? {
            'x-trace-name': encodeURIComponent(args.traceName),
            ...(state.traceId ? { 'x-trace-id': state.traceId } : {}),
            ...(traceConf.sessionId ? { 'x-session-id': traceConf.sessionId } : {}),
            ...(traceConf.tags?.length ? { 'x-trace-tags': traceConf.tags.join(', ') } : {}),
            ...(traceConf.metadata && Object.keys(traceConf.metadata).length
              ? { 'x-trace-metadata': JSON.stringify(traceConf.metadata) }
              : {}),
          }
        : undefined;

      const meta: { gateway?: GatewayCallMeta } = {};
      for await (const chunk of this._streamChat(this._buildChatBody(chatOptions, true), extraHeaders, meta)) {
        const text = take(chunk);
        if (text && emitContent) yield { type: 'content', delta: text, round: roundIndex };
      }
      out.spanRef = meta.gateway?.spanRef ?? undefined;
      if (traceEnabled && !state.traceId) state.traceId = meta.gateway?.traceId ?? undefined;
    }

    const assembled: ToolCall[] = [...toolCallParts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, p]) => ({ id: p.id, type: 'function' as const, function: { name: p.name, arguments: p.arguments } }));
    out.message = {
      role: 'assistant',
      content: contentParts.join(''),
      ...(assembled.length ? { tool_calls: assembled } : {}),
    };
    out.finishReason = finishReason;
  }

  /**
   * @internal Runs one tool call the model asked for and returns its `tool` message.
   *
   * The single place any tool call is executed, shared by the blocking loop and the
   * streaming one — routing (`http` executor on the platform, declared tool in-process,
   * or the caller's `dispatch`), the `tool` span, and the error span all live here so the
   * two loops cannot drift apart in what they run or record.
   *
   * An `http` route is executed by the platform, which writes that span itself, so
   * nothing is pushed to `toolSpans` for it — recording one here would show the same
   * execution twice in the trace.
   *
   * `ctx.onSettled` fires the moment the tool finishes, before this resolves: how the
   * streaming loop emits a `tool_result` event per tool instead of one batch after all
   * of them.
   */
  private async _dispatchToolCall(
    call: ToolCall,
    ctx: {
      callIndex: number;
      roundIndex: number;
      routes: Map<string, ToolRoute>;
      dispatch?: RunToolLoopOptions['dispatch'];
      traceEnabled: boolean;
      traceId?: string;
      llmSpanRef?: string;
      toolSpans: IngestSpan[];
      onSettled?: (id: string, name: string, result: unknown, error?: string) => void;
    },
  ): Promise<Message> {
    const name = call.function.name;
    const args = parseCallArguments(call);
    const route = ctx.routes.get(name);

    if (route?.kind === 'http') {
      const executed = await this.host.tools.execute(route.toolId ?? '', args, {
        alias: route.alias,
        versionNumber: route.versionNumber,
        traceId: ctx.traceEnabled ? ctx.traceId : undefined,
        parentSpanId: ctx.llmSpanRef,
      });
      const ret = executed.result;
      ctx.onSettled?.(call.id, name, ret, undefined);
      const content = typeof ret === 'string' ? ret : (JSON.stringify(ret) ?? 'null');
      return { role: 'tool', tool_call_id: call.id, content };
    }

    let run: () => Promise<unknown> | unknown;
    if (route?.kind === 'local' && route.tool) {
      const declared = route.tool;
      run = () => declared.handler(parseToolArgs(declared, args));
    } else if (route?.kind === 'client' && route.fn) {
      // No declared schema to parse against — the catalog owns this tool's schema, so the
      // function gets the arguments the model produced.
      const fn = route.fn;
      run = () => fn(args);
    } else if (ctx.dispatch) {
      const dispatch = ctx.dispatch;
      run = () => dispatch(name, args);
    } else {
      throw new acruxcoreError(
        `acruxcore: the model called '${name}', which has no implementation. Pass it in ` +
          `clientTools: { ${name} }, the declared tool in tools: [...], or pass dispatch.`,
        'MISSING_DISPATCH',
      );
    }

    const toolSpanId = `tool-${ctx.roundIndex}-${ctx.callIndex}`;
    const toolStart = new Date().toISOString();
    const attributes: Record<string, unknown> = {
      arguments: args,
      executorType: 'client',
      ...(route?.toolVersionId ? { toolVersionId: route.toolVersionId } : {}),
    };
    return Promise.resolve(run()).then(
      (result): Message => {
        ctx.toolSpans.push({
          spanId: toolSpanId, parentSpanId: ctx.llmSpanRef, name, kind: 'tool',
          status: 'ok', startTime: toolStart, endTime: new Date().toISOString(),
          input: args, output: result ?? null, attributes,
        });
        ctx.onSettled?.(call.id, name, result, undefined);
        const content = typeof result === 'string' ? result : (JSON.stringify(result) ?? 'null');
        return { role: 'tool', tool_call_id: call.id, content };
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        ctx.toolSpans.push({
          spanId: toolSpanId, parentSpanId: ctx.llmSpanRef, name, kind: 'tool',
          status: 'error', startTime: toolStart, endTime: new Date().toISOString(),
          input: args, attributes, error: message,
        });
        ctx.onSettled?.(call.id, name, undefined, message);
        throw err;
      },
    );
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
