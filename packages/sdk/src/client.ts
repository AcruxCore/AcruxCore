import type { acruxcoreConfig, ProviderConfig } from './types';
import { createHash } from 'node:crypto';
import { acruxcoreError } from './error';
import { fetchWithRetry } from './fetch';
import { ToolsNamespace } from './tools-api';
import { TracesNamespace } from './traces-api';
import { SessionsNamespace } from './sessions-api';
import { PromptsNamespace } from './prompts-api';
import { DatasetsNamespace, ExperimentsNamespace, RunsNamespace, OptimizeNamespace } from './evaluations';
import { GatewayNamespace, warnIfCleartextUrl } from './gateway-api';
import { SpanQueue } from './span-queue';

const DEFAULT_MAX_CACHE_SIZE = 500;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_INTERVAL = 500;

/**
 * Client for AcruxCore — prompt render, gateway chat, tool loops, traces,
 * and feedback.
 *
 * Create one instance at process startup and reuse it — the cache is a
 * module-level singleton and `maxCacheSize` is set by the first constructor call.
 *
 * Every method is accessed through its domain namespace:
 * - `hub.prompts.*` — prompt lifecycle + render
 * - `hub.gateway.*` — chat, stream, runToolLoop, flush, close
 * - `hub.traces.*` — trace CRUD, analytics, feedback
 * - `hub.tools.*` — tool catalog operations
 * - `hub.sessions.*` — session listing
 * - `hub.datasets.*` / `hub.experiments.*` / `hub.runs.*` / `hub.optimize.*` — evaluations
 *
 * @example
 * ```typescript
 * const hub = new acruxcore({ apiKey: process.env.ACRUXCORE_API_KEY, baseUrl: process.env.ACRUXCORE_BASE_URL });
 * const { messages, tools } = await hub.prompts.render('my-prompt', 'production', { name: 'Alice' });
 * ```
 */
export class acruxcore {
  /** @internal */
  readonly apiKey: string;
  /** @internal */
  readonly baseUrl: string;
  /** @internal */
  readonly maxRetries: number;
  /** @internal */
  readonly retryInterval: number;
  /** @internal */
  readonly providerDefault?: ProviderConfig;
  /** @internal */
  readonly spanQueue: SpanQueue;

  /** Catalog operations — see {@link ToolsNamespace}. */
  public readonly tools: ToolsNamespace;

  /** Trace analytics, facet discovery, settings, feedback, and trace CRUD — see {@link TracesNamespace}. */
  public readonly traces: TracesNamespace;

  /** Session listing and detail — see {@link SessionsNamespace}. */
  public readonly sessions: SessionsNamespace;

  /** Prompt and prompt-version lifecycle operations — see {@link PromptsNamespace}. */
  public readonly prompts: PromptsNamespace;

  /** Evaluations: datasets — see {@link DatasetsNamespace}. */
  public readonly datasets: DatasetsNamespace;

  /** Evaluations: experiments — see {@link ExperimentsNamespace}. */
  public readonly experiments: ExperimentsNamespace;

  /** Evaluations: runs — see {@link RunsNamespace}. */
  public readonly runs: RunsNamespace;

  /** Evaluations: optimize — see {@link OptimizeNamespace}. */
  public readonly optimize: OptimizeNamespace;

  /** Gateway, BYO-provider, and tool-loop operations — see {@link GatewayNamespace}. */
  public readonly gateway: GatewayNamespace;

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
    warnIfCleartextUrl(this.baseUrl, 'baseUrl');
    this.maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryInterval = config?.retryInterval ?? DEFAULT_RETRY_INTERVAL;
    this.providerDefault = config?.provider;

    this.tools = new ToolsNamespace(this);
    this.traces = new TracesNamespace(this);
    this.sessions = new SessionsNamespace(this);
    this.prompts = new PromptsNamespace(this, config?.cacheTtl ?? 60_000, config?.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE);
    this.datasets = new DatasetsNamespace(this);
    this.experiments = new ExperimentsNamespace(this);
    this.runs = new RunsNamespace(this);
    this.optimize = new OptimizeNamespace(this);

    this.spanQueue = new SpanQueue(async (batch) => {
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
    });

    this.gateway = new GatewayNamespace(this);
  }

  /**
   * Short, non-reversible fingerprint of this client's key, for cache keys.
   *
   * @internal Used by {@link ToolsNamespace} and {@link PromptsNamespace}.
   * @returns A 16-hex-character digest.
   */
  _apiKeyFingerprint(): string {
    return createHash('sha256').update(this.apiKey).digest('hex').slice(0, 16);
  }

  /**
   * Generic authenticated fetch against this instance's baseUrl.
   *
   * @internal Not part of the public API — callers go through typed methods.
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

  /**
   * @internal Builds the Authorization/Content-Type header pair shared by every
   * authenticated request.
   */
  private _authHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
  }

  /**
   * Enables `await using hub = new acruxcore(...)` on runtimes that have
   * `Symbol.asyncDispose` (Node 20.4 and later). Delegates to `gateway.close()`.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.gateway.close();
  }
}
