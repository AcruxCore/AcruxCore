import { createHash } from 'node:crypto';
import { acruxcoreError } from './error';
import { type AcruxTool, isAcruxTool, resolveParametersSchema } from './tools';
import type { ResolvedTool, ToolExecuteResult, ToolSyncResult } from './types';

/**
 * The subset of the client this namespace needs.
 *
 * Declared structurally rather than importing `acruxcore`, which would be a runtime
 * circular import: the client constructs this namespace.
 */
export interface ToolsNamespaceHost {
  _request(
    method: string,
    path: string,
    body: unknown,
    errorContext: string,
    extraHeaders?: Record<string, string>,
  ): Promise<Response>;
  _parseJsonOrThrow(response: Response, errorContext: string): Promise<unknown>;
  _apiKeyFingerprint(): string;
}

/**
 * Max entries in the process-wide sync cache. A deploy syncs a handful of tools; the
 * bound only exists so a pathological caller cannot grow it without limit.
 */
const MAX_SYNC_CACHE = 256;

/**
 * spec-hash → ToolSyncResult, so a loop that starts many times per process pays for
 * reconciliation once. Process-wide (not per-client) because the key includes the
 * api-key fingerprint, so two clients for different teams cannot collide.
 */
const syncCache = new Map<string, ToolSyncResult>();

/** Clears the process-wide sync cache. Test-only. */
export function _resetSyncCacheForTesting(): void {
  syncCache.clear();
}

/** Deep-sorts object keys so key order cannot change a hash. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortDeep((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** Stable fingerprint of everything a sync would send, plus which team it goes to. */
function specHash(
  payload: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    executor: unknown;
    alias: string;
  },
  apiKeyFingerprint: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify(sortDeep({ k: apiKeyFingerprint, ...payload })))
    .digest('hex');
}

/** Options for {@link ToolsNamespace.sync}. */
export interface ToolSyncOptions {
  /**
   * `'warn'` (default) logs a warning when a commit supersedes a dashboard-authored
   * version; `'error'` throws instead. Warn is the default deliberately: a hard failure
   * would let any dashboard experiment block the next deploy.
   */
  onConflict?: 'warn' | 'error';
}

/** Options for {@link ToolsNamespace.execute}. */
export interface ToolExecuteOptions {
  /** Which alias to run; omitted means the server's default (`production`). */
  alias?: string;
  /** Pin an exact version instead of following an alias. */
  versionNumber?: number;
  /** Trace to attach the span to — pass the loop's trace to land in one waterfall. */
  traceId?: string;
  /** Span to nest under, normally the `llm` span that requested the call. */
  parentSpanId?: string;
}

/**
 * Catalog operations, reached as `hub.tools`.
 *
 * Held as a separate object rather than more methods on `acruxcore` so the client's
 * surface stays readable as the catalog grows.
 */
export class ToolsNamespace {
  private readonly client: ToolsNamespaceHost;

  /**
   * @param client - The owning client, used for its request/parse helpers and its key.
   */
  constructor(client: ToolsNamespaceHost) {
    this.client = client;
  }

  /**
   * Reconciles tools declared with `acrux.tool` against the catalog.
   *
   * Idempotent, and cached per process on the spec's hash: calling it twice with an
   * unchanged tool makes one request. Tools are reconciled sequentially, so a failure on
   * the second one leaves the first already committed — the endpoint is per-tool atomic,
   * not per-batch.
   *
   * @param tools - Values returned by `acrux.tool`.
   * @param options - `onConflict` behaviour; see {@link ToolSyncOptions}.
   * @returns One {@link ToolSyncResult} per tool, in input order.
   * @throws {acruxcoreError} A value is not an `acrux.tool`, the API rejects a spec, or
   *   `onConflict: 'error'` and a dashboard version was superseded.
   */
  async sync(tools: AcruxTool<never>[], options?: ToolSyncOptions): Promise<ToolSyncResult[]> {
    const results: ToolSyncResult[] = [];
    for (const t of tools) {
      if (!isAcruxTool(t)) {
        throw new acruxcoreError(
          'acruxcore: a value passed to tools.sync() was not created by acrux.tool. Declare it ' +
            'with acrux.tool({ name, parameters }, handler), or pass a raw OpenAI tool definition ' +
            'as toolDefs= instead of tools=.',
          'TOOL_SCHEMA_ERROR',
        );
      }
      results.push(await this.syncOne(t, options));
    }
    return results;
  }

  /**
   * Reconciles one tool. See {@link sync} for the semantics.
   *
   * @param t - The tool to reconcile.
   * @param options - `onConflict` behaviour.
   * @returns The sync outcome. A cache hit reports `committed: false`, because nothing
   *   was committed by *this* call.
   * @throws {acruxcoreError} On a non-2xx response, on `ZOD_NOT_AVAILABLE` when a zod
   *   schema cannot be converted, or on a superseded dashboard version when
   *   `onConflict: 'error'`.
   */
  async syncOne(t: AcruxTool<never>, options?: ToolSyncOptions): Promise<ToolSyncResult> {
    // Where a zod schema becomes JSON Schema, and where ZOD_NOT_AVAILABLE surfaces.
    const parameters = await resolveParametersSchema(t.parameters);
    const key = specHash(
      {
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        parameters,
        executor: t.executor,
        alias: t.alias,
      },
      this.client._apiKeyFingerprint(),
    );

    const cached = syncCache.get(key);
    if (cached) {
      return {
        toolId: cached.toolId,
        versionNumber: cached.versionNumber,
        committed: false,
        alias: cached.alias,
      };
    }

    const body: Record<string, unknown> = {
      name: t.name,
      parametersSchema: parameters,
      executor: t.executor,
      alias: t.alias,
      source: 'code',
    };
    // A tool with no description sends NO description key, which is what hands ownership
    // of the model-facing text to the dashboard. Sending null instead would erase
    // whatever was written there.
    if (t.description !== undefined) body['description'] = t.description;
    if (t.changelog !== undefined) body['changelog'] = t.changelog;

    const response = await this.client._request('POST', '/tools/sync', body, 'syncing tool');
    const data = (await this.client._parseJsonOrThrow(response, 'syncing tool')) as ToolSyncResult;
    const result: ToolSyncResult = {
      toolId: data.toolId,
      versionNumber: data.versionNumber,
      committed: Boolean(data.committed),
      alias: data.alias,
      ...(data.supersededSource ? { supersededSource: data.supersededSource } : {}),
    };

    if (result.supersededSource === 'dashboard') {
      // Word for word the same as the Python SDK's message, so the two read the same in
      // a log aggregator.
      const message =
        `acruxcore: syncing '${t.name}' committed v${result.versionNumber} from code and ` +
        `moved '${result.alias}' to it, superseding a version edited in the dashboard. That ` +
        `version still exists and can be promoted back from the tool's version list.`;
      if (options?.onConflict === 'error') throw new acruxcoreError(message, 'API_ERROR');
      console.warn(message);
    }

    if (syncCache.size >= MAX_SYNC_CACHE) syncCache.clear();
    syncCache.set(key, result);
    return result;
  }

  /**
   * Resolves catalog refs to schemas plus executor types, in one request.
   *
   * @param refs - `[{ name, alias? }]`; `alias` defaults to `production` server-side.
   * @returns One {@link ResolvedTool} per ref, in input order.
   * @throws {acruxcoreError} `API_ERROR` with `statusCode` 404 when any ref does not
   *   resolve; `body.error.refs` names every failure.
   */
  async resolve(refs: { name: string; alias?: string }[]): Promise<ResolvedTool[]> {
    const payload = refs.map((r) => ({ name: r.name, ...(r.alias ? { alias: r.alias } : {}) }));
    const response = await this.client._request(
      'POST',
      '/tools/resolve',
      { refs: payload },
      'resolving tools',
    );
    const data = (await this.client._parseJsonOrThrow(response, 'resolving tools')) as {
      data?: ResolvedTool[];
    };
    return data.data ?? [];
  }

  /**
   * Runs a tool's server-side `http` executor on the platform.
   *
   * The platform writes the `tool` span for this call itself — with the version that ran
   * and the real payloads — so a caller must NOT also report one, or the trace shows the
   * same execution twice.
   *
   * @param toolId - The tool's id, from {@link resolve}.
   * @param args - The model's parsed arguments.
   * @param options - Alias/version pinning and trace context.
   * @returns The tool's result plus status, latency and the version that ran.
   * @throws {acruxcoreError} 404 unknown tool, 422 `NOT_EXECUTABLE` (the resolved version
   *   has no server-side executor), or 400 from the executor itself.
   */
  async execute(
    toolId: string,
    args: Record<string, unknown>,
    options?: ToolExecuteOptions,
  ): Promise<ToolExecuteResult> {
    const body: Record<string, unknown> = { arguments: args };
    if (options?.alias !== undefined) body['alias'] = options.alias;
    if (options?.versionNumber !== undefined) body['versionNumber'] = options.versionNumber;
    const traceContext: Record<string, string> = {};
    if (options?.traceId) traceContext['traceId'] = options.traceId;
    if (options?.parentSpanId) traceContext['parentSpanId'] = options.parentSpanId;
    if (Object.keys(traceContext).length > 0) body['traceContext'] = traceContext;

    const response = await this.client._request(
      'POST',
      `/tools/${encodeURIComponent(toolId)}/execute`,
      body,
      'executing tool',
    );
    return (await this.client._parseJsonOrThrow(response, 'executing tool')) as ToolExecuteResult;
  }
}
