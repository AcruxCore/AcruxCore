import { createHash } from 'node:crypto';
import { acruxcoreError } from './error';
import { type AcruxTool, isAcruxTool, resolveParametersSchema } from './tools';
import type {
  CommitToolVersionInput,
  CreateToolInput,
  ListToolsOptions,
  ListToolVersionsOptions,
  ResolvedTool,
  ToolAliasDetail,
  ToolAnalyticsOptions,
  ToolAnalyticsResult,
  ToolDetail,
  ToolExecuteResult,
  ToolRef,
  ToolListResult,
  ToolSyncResult,
  ToolVersionDetail,
  ToolVersionListResult,
  UpdateToolInput,
} from './types';
import type { NamespaceHost } from './host';

/**
 * The subset of the client this namespace needs.
 *
 * Declared structurally rather than importing `acruxcore`, which would be a runtime
 * circular import: the client constructs this namespace.
 */
export type ToolsNamespaceHost = NamespaceHost;

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
   * @param refs - `[{ name, alias? }]`, or `[{ name, version }]` to pin one exact build.
   *   `alias` defaults to `production` server-side; a ref carrying both is a 400.
   * @returns One {@link ResolvedTool} per ref, in input order.
   * @throws {acruxcoreError} `API_ERROR` with `statusCode` 404 when any ref does not
   *   resolve; `body.error.refs` names every failure.
   */
  async resolve(refs: ToolRef[]): Promise<ResolvedTool[]> {
    const payload = refs.map((r) => ({
      name: r.name,
      ...(r.alias ? { alias: r.alias } : {}),
      ...(r.version !== undefined ? { version: r.version } : {}),
    }));
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

  /**
   * Lists tools for the team, newest first.
   *
   * @param options - Optional free-text `search` and pagination.
   * @returns One page of tools.
   * @throws {acruxcoreError} API_ERROR on a non-2xx response.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async list(options?: ListToolsOptions): Promise<ToolListResult> {
    const params = new URLSearchParams();
    if (options?.search !== undefined) params.set('search', options.search);
    if (options?.page !== undefined) params.set('page', String(options.page));
    if (options?.limit !== undefined) params.set('limit', String(options.limit));

    const qs = params.toString();
    const response = await this.client._request('GET', `/tools${qs ? `?${qs}` : ''}`, undefined, 'listing tools');
    return this.client._parseJsonOrThrow(response, 'listing tools') as Promise<ToolListResult>;
  }

  /**
   * Fetches one tool's shell by id.
   *
   * @param id - The tool's id (UUID).
   * @returns The tool.
   * @throws {acruxcoreError} API_ERROR with `statusCode` 404 if the tool doesn't
   *   exist (or belongs to another team), including after a soft-delete.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async get(id: string): Promise<ToolDetail> {
    const response = await this.client._request('GET', `/tools/${encodeURIComponent(id)}`, undefined, 'fetching tool');
    return this.client._parseJsonOrThrow(response, 'fetching tool') as Promise<ToolDetail>;
  }

  /**
   * Creates a new tool shell. A tool has no schema/executor of its own — commit a
   * version with {@link commitVersion} to give it one.
   *
   * @param input - `name` (required, must match `^[a-zA-Z0-9_-]{1,64}$` and be unique
   *   per team) and optional `description`.
   * @returns The created tool.
   * @throws {acruxcoreError} API_ERROR with code `VALIDATION_ERROR` (e.g. a name that
   *   doesn't match the pattern).
   * @throws {acruxcoreError} API_ERROR with code `TOOL_NAME_TAKEN` (409) if a tool
   *   with that name already exists in the team.
   * @throws {acruxcoreError} API_ERROR 403 if the caller's role cannot create tools
   *   (editor and above only).
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async create(input: CreateToolInput): Promise<ToolDetail> {
    const response = await this.client._request('POST', '/tools', input, 'creating tool');
    return this.client._parseJsonOrThrow(response, 'creating tool') as Promise<ToolDetail>;
  }

  /**
   * Updates a tool's `name` and/or `description`. Does not touch its versions —
   * versions are immutable and unaffected by renaming the tool they belong to.
   *
   * @param id - The tool's id.
   * @param input - At least one of `name`/`description`; pass `description: null` to
   *   clear it, or omit it to leave it untouched.
   * @returns The updated tool.
   * @throws {acruxcoreError} API_ERROR 404 unknown tool, or `VALIDATION_ERROR` if
   *   neither field is set.
   * @throws {acruxcoreError} API_ERROR 403 if the caller's role cannot update tools
   *   (editor and above only).
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async update(id: string, input: UpdateToolInput): Promise<ToolDetail> {
    const response = await this.client._request('PATCH', `/tools/${encodeURIComponent(id)}`, input, 'updating tool');
    return this.client._parseJsonOrThrow(response, 'updating tool') as Promise<ToolDetail>;
  }

  /**
   * Soft-deletes a tool: it stops appearing in {@link list}/{@link get}, but its
   * versions and aliases are preserved (just unreachable) rather than removed.
   *
   * The endpoint replies `204 No Content` on success, which has no body — calling
   * `_parseJsonOrThrow` unconditionally would throw trying to parse it, so the
   * success path returns directly and only a non-2xx response is parsed (to get
   * the typed error thrown).
   *
   * @param id - The tool's id.
   * @throws {acruxcoreError} API_ERROR with `statusCode` 404 if the tool doesn't exist.
   * @throws {acruxcoreError} API_ERROR 403 if the caller's role cannot delete tools
   *   (editor and above only).
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async delete(id: string): Promise<void> {
    const response = await this.client._request('DELETE', `/tools/${encodeURIComponent(id)}`, undefined, 'deleting tool');
    if (!response.ok) {
      await this.client._parseJsonOrThrow(response, 'deleting tool');
    }
  }

  /**
   * Commits a new immutable version for a tool.
   *
   * @param toolId - The tool's id.
   * @param input - The version's schema and executor, plus optional `description`/
   *   `changelog`. `source` defaults to `'api'` server-side; `'code'` is rejected here
   *   — only `tools.sync` (`POST /tools/sync`) may write it.
   * @returns The created version. `aliases` is present ONLY when this is the tool's
   *   first version — both `production` and `staging` are minted and point at it;
   *   every later commit returns no `aliases` at all. `warnings` is present only when
   *   this commit has a `changelog` but no `description` (a likely omission, not an
   *   error).
   * @throws {acruxcoreError} API_ERROR 404 unknown tool, or `VALIDATION_ERROR` (e.g.
   *   invalid `executor` shape, or a `source` of `'code'`).
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async commitVersion(toolId: string, input: CommitToolVersionInput): Promise<ToolVersionDetail> {
    const response = await this.client._request(
      'POST',
      `/tools/${encodeURIComponent(toolId)}/versions`,
      input,
      'committing tool version',
    );
    return this.client._parseJsonOrThrow(response, 'committing tool version') as Promise<ToolVersionDetail>;
  }

  /**
   * Lists a tool's versions, newest first. List items omit `parametersSchema`/
   * `executor` to keep pages small — use {@link getVersion} for the full content.
   *
   * @param toolId - The tool's id.
   * @param options - Pagination (`page` is 1-based).
   * @returns One page of versions.
   * @throws {acruxcoreError} API_ERROR 404 unknown tool.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async listVersions(toolId: string, options?: ListToolVersionsOptions): Promise<ToolVersionListResult> {
    const params = new URLSearchParams();
    if (options?.page !== undefined) params.set('page', String(options.page));
    if (options?.limit !== undefined) params.set('limit', String(options.limit));

    const qs = params.toString();
    const response = await this.client._request(
      'GET',
      `/tools/${encodeURIComponent(toolId)}/versions${qs ? `?${qs}` : ''}`,
      undefined,
      'listing tool versions',
    );
    return this.client._parseJsonOrThrow(response, 'listing tool versions') as Promise<ToolVersionListResult>;
  }

  /**
   * Fetches one version with its full `parametersSchema`/`executor`. Unlike
   * {@link commitVersion}'s response, this never includes `aliases`/`warnings` —
   * only the commit response ever has either.
   *
   * @param toolId - The tool's id.
   * @param versionNumber - The version's sequential number (1-based, immutable).
   * @returns The version.
   * @throws {acruxcoreError} API_ERROR 404 unknown tool or version number.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async getVersion(toolId: string, versionNumber: number): Promise<ToolVersionDetail> {
    const response = await this.client._request(
      'GET',
      `/tools/${encodeURIComponent(toolId)}/versions/${encodeURIComponent(String(versionNumber))}`,
      undefined,
      'fetching tool version',
    );
    return this.client._parseJsonOrThrow(response, 'fetching tool version') as Promise<ToolVersionDetail>;
  }

  /**
   * Promotes an alias to point at a specific version — e.g. rolling `production`
   * forward (or back) to a version already committed. Creates the alias if it does
   * not exist yet.
   *
   * @param toolId - The tool's id.
   * @param alias - The alias name (e.g. `'production'`, `'staging'`, or a custom one).
   * @param versionNumber - The version to point the alias at.
   * @returns The alias's new state.
   * @throws {acruxcoreError} API_ERROR 404 unknown tool/version, or 403 if the
   *   caller's role cannot promote (editor and above only).
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async promoteAlias(toolId: string, alias: string, versionNumber: number): Promise<ToolAliasDetail> {
    const response = await this.client._request(
      'POST',
      `/tools/${encodeURIComponent(toolId)}/aliases/${encodeURIComponent(alias)}/promote`,
      { version_number: versionNumber },
      'promoting tool alias',
    );
    return this.client._parseJsonOrThrow(response, 'promoting tool alias') as Promise<ToolAliasDetail>;
  }

  /**
   * Reads aggregated call analytics (count, error rate, p50/p95 latency) per tool,
   * over an optional time window.
   *
   * @param options - Optional `since`/`until` ISO-8601 datetime bounds; either or both
   *   may be omitted to leave that side of the window open.
   * @returns One entry per tool that had calls in the window. Empty `data` when
   *   nothing executed, or the window excludes every execution.
   * @throws {acruxcoreError} API_ERROR with code `VALIDATION_ERROR` on a non-ISO-8601
   *   `since`/`until`.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async analytics(options?: ToolAnalyticsOptions): Promise<ToolAnalyticsResult> {
    const params = new URLSearchParams();
    if (options?.since !== undefined) params.set('since', options.since);
    if (options?.until !== undefined) params.set('until', options.until);

    const qs = params.toString();
    const response = await this.client._request(
      'GET',
      `/tools/analytics${qs ? `?${qs}` : ''}`,
      undefined,
      'fetching tool analytics',
    );
    return this.client._parseJsonOrThrow(response, 'fetching tool analytics') as Promise<ToolAnalyticsResult>;
  }
}
