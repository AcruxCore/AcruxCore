import { createHash } from 'node:crypto';
import type {
  AliasDetail,
  AliasToolBindingInput,
  CommitVersionInput,
  CreatePromptInput,
  DiffResult,
  ExportedPromptVersion,
  ImportPromptInput,
  ImportPromptResult,
  ListPromptsOptions,
  ListTracesResult,
  ListVersionsOptions,
  Message,
  PromptDetail,
  PromptListResult,
  PromptToolBindings,
  PromptVersionTracesOptions,
  RenderResult,
  ToolBindingDetail,
  ToolBindingInput,
  ToolDefinition,
  ToolResolution,
  UpdatePromptInput,
  VersionDetail,
  VersionListResult,
} from './types';
import type { NamespaceHost } from './host';
import { acruxcoreError } from './error';
import { getCache } from './cache';
import { fetchWithRetry } from './fetch';

/**
 * The subset of the client this namespace needs.
 *
 * Declared structurally rather than importing `acruxcore`, which would be a runtime
 * circular import: the client constructs this namespace.
 */
export type PromptsNamespaceHost = NamespaceHost;

// ── Cache key helpers (moved from client.ts) ──

/**
 * Hashes an API key for use in a cache key — never store the raw key verbatim.
 * Truncated to 16 hex chars.
 */
function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

/**
 * Serialises a value with object keys in sorted order, at every depth, so that
 * two variable maps that differ only in insertion order produce one string.
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
 * in the cache key.
 */
function hashVariables(variables: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(variables)).digest('hex').slice(0, 16);
}

/**
 * Converts a binding input to the wire body, which is snake_case (`tool_alias`,
 * `pinned_version_number`, `off`) like the rest of the prompts API's request bodies.
 *
 * The API takes exactly one of the three and 400s otherwise. The types already stop a
 * TypeScript caller sending two, but nothing stops a JavaScript one sending zero, and
 * an empty body would come back as an opaque 400 — so that case is rejected here, with
 * a message naming what to pass.
 *
 * @param binding - What the caller asked to bind the tool to.
 * @param allowOff - `true` on the per-alias endpoint, which is the only one where
 *   `off` means anything (there is no default for a default to contradict).
 * @returns The request body.
 * @throws {acruxcoreError} VALIDATION_ERROR when no target is named, or `off` is used
 *   on the default binding.
 */
function bindingBody(binding: AliasToolBindingInput, allowOff: boolean): Record<string, unknown> {
  if ('toolAlias' in binding && binding.toolAlias !== undefined) {
    return { tool_alias: binding.toolAlias };
  }
  if ('pinnedVersionNumber' in binding && binding.pinnedVersionNumber !== undefined) {
    return { pinned_version_number: binding.pinnedVersionNumber };
  }
  if ('off' in binding && binding.off) {
    if (!allowOff) {
      throw new acruxcoreError(
        'acruxcore: { off: true } is only valid for a prompt alias\'s own binding. To stop every ' +
          'alias from calling the tool, remove the default binding with prompts.removeToolBinding().',
        'VALIDATION_ERROR',
      );
    }
    return { off: true };
  }
  throw new acruxcoreError(
    'acruxcore: a tool binding needs exactly one of { toolAlias }, { pinnedVersionNumber }' +
      (allowOff ? ', or { off: true }.' : '.'),
    'VALIDATION_ERROR',
  );
}

/**
 * Prompt and prompt-version lifecycle operations, reached as `hub.prompts`.
 *
 * Held as a separate object rather than more methods on `acruxcore` so the client's
 * surface stays readable as the catalog grows — mirrors {@link ToolsNamespace}.
 */
export class PromptsNamespace {
  private readonly client: PromptsNamespaceHost;
  private readonly cacheTtl: number;
  private readonly maxCacheSize: number;

  /**
   * @param client - The owning client, used for its request/parse helpers.
   * @param cacheTtl - Milliseconds before a cached render is stale. Default 60000.
   * @param maxCacheSize - Max LRU entries. Default 500.
   */
  constructor(client: PromptsNamespaceHost, cacheTtl = 60_000, maxCacheSize = 500) {
    this.client = client;
    this.cacheTtl = cacheTtl;
    this.maxCacheSize = maxCacheSize;
  }

  /**
   * Lists prompts for the team, newest first.
   *
   * @param options - Optional free-text `search` and pagination.
   * @returns One page of prompts.
   * @throws {acruxcoreError} API_ERROR on a non-2xx response.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async list(options?: ListPromptsOptions): Promise<PromptListResult> {
    const params = new URLSearchParams();
    if (options?.search !== undefined) params.set('search', options.search);
    if (options?.page !== undefined) params.set('page', String(options.page));
    if (options?.limit !== undefined) params.set('limit', String(options.limit));

    const qs = params.toString();
    const response = await this.client._request('GET', `/prompts${qs ? `?${qs}` : ''}`, undefined, 'listing prompts');
    return this.client._parseJsonOrThrow(response, 'listing prompts') as Promise<PromptListResult>;
  }

  /**
   * Fetches one prompt by id.
   *
   * @param id - The prompt's id (UUID).
   * @returns The prompt.
   * @throws {acruxcoreError} API_ERROR with `statusCode` 404 if the prompt doesn't
   *   exist (or belongs to another team).
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async get(id: string): Promise<PromptDetail> {
    const response = await this.client._request(
      'GET',
      `/prompts/${encodeURIComponent(id)}`,
      undefined,
      'fetching prompt',
    );
    return this.client._parseJsonOrThrow(response, 'fetching prompt') as Promise<PromptDetail>;
  }

  /**
   * Creates a new prompt. A prompt has no messages of its own — commit a version
   * with {@link commitVersion} to give it content.
   *
   * @param input - `name` (required, unique per team) and optional `description`.
   * @returns The created prompt.
   * @throws {acruxcoreError} API_ERROR with code `VALIDATION_ERROR` (e.g. empty name).
   * @throws {acruxcoreError} API_ERROR 403 if the caller's role cannot create
   *   prompts (editor and above only).
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async create(input: CreatePromptInput): Promise<PromptDetail> {
    const response = await this.client._request('POST', '/prompts', input, 'creating prompt');
    return this.client._parseJsonOrThrow(response, 'creating prompt') as Promise<PromptDetail>;
  }

  /**
   * Updates a prompt's `name` and/or `description`. Does not touch its versions —
   * versions are immutable and unaffected by renaming the prompt they belong to.
   *
   * @param id - The prompt's id.
   * @param input - At least one of `name`/`description`; pass `description: null` to clear it.
   * @returns The updated prompt.
   * @throws {acruxcoreError} API_ERROR 404 unknown prompt, or `VALIDATION_ERROR` if
   *   neither field is set.
   * @throws {acruxcoreError} API_ERROR 403 if the caller's role cannot update
   *   prompts (editor and above only).
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async update(id: string, input: UpdatePromptInput): Promise<PromptDetail> {
    const response = await this.client._request(
      'PATCH',
      `/prompts/${encodeURIComponent(id)}`,
      input,
      'updating prompt',
    );
    return this.client._parseJsonOrThrow(response, 'updating prompt') as Promise<PromptDetail>;
  }

  /**
   * Deletes a prompt and every version/alias under it.
   *
   * The endpoint replies `204 No Content` on success, which has no body — calling
   * `_parseJsonOrThrow` unconditionally would throw trying to parse it, so the
   * success path returns directly and only a non-2xx response is parsed (to get
   * the typed error thrown).
   *
   * @param id - The prompt's id.
   * @throws {acruxcoreError} API_ERROR with `statusCode` 404 if the prompt doesn't exist.
   * @throws {acruxcoreError} API_ERROR 403 if the caller's role cannot delete
   *   prompts (editor and above only).
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async delete(id: string): Promise<void> {
    const response = await this.client._request(
      'DELETE',
      `/prompts/${encodeURIComponent(id)}`,
      undefined,
      'deleting prompt',
    );
    if (!response.ok) {
      await this.client._parseJsonOrThrow(response, 'deleting prompt');
    }
  }

  /**
   * Commits a new immutable version for a prompt.
   *
   * A version decides the template only — it says nothing about tools. Which tools
   * the prompt calls is decided per prompt alias by {@link setToolBinding} and
   * {@link setAliasToolBinding}, so committing never changes a tool set.
   *
   * @param promptId - The prompt's id.
   * @param input - The version's full message list and an optional bound default model.
   * @returns The created version. `aliases` is present ONLY when this is the
   *   prompt's first version — both `production` and `staging` are minted and
   *   point at it; every later commit returns no `aliases` at all.
   * @throws {acruxcoreError} API_ERROR 404 unknown prompt, or `VALIDATION_ERROR`
   *   (e.g. empty `messages`).
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async commitVersion(promptId: string, input: CommitVersionInput): Promise<VersionDetail> {
    const response = await this.client._request(
      'POST',
      `/prompts/${encodeURIComponent(promptId)}/versions`,
      input,
      'committing prompt version',
    );
    return this.client._parseJsonOrThrow(response, 'committing prompt version') as Promise<VersionDetail>;
  }

  /**
   * Lists a prompt's versions, newest first. List items omit `messages`/`promptId`
   * to keep pages small — use {@link getVersion} for full content.
   *
   * @param promptId - The prompt's id.
   * @param options - Pagination (`page` is 1-based).
   * @returns One page of versions.
   * @throws {acruxcoreError} API_ERROR 404 unknown prompt.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async listVersions(promptId: string, options?: ListVersionsOptions): Promise<VersionListResult> {
    const params = new URLSearchParams();
    if (options?.page !== undefined) params.set('page', String(options.page));
    if (options?.limit !== undefined) params.set('limit', String(options.limit));

    const qs = params.toString();
    const response = await this.client._request(
      'GET',
      `/prompts/${encodeURIComponent(promptId)}/versions${qs ? `?${qs}` : ''}`,
      undefined,
      'listing prompt versions',
    );
    return this.client._parseJsonOrThrow(response, 'listing prompt versions') as Promise<VersionListResult>;
  }

  /**
   * Fetches one version with its full message content. Unlike {@link commitVersion}'s
   * response, this never includes `aliases` — only the commit response ever has it.
   *
   * @param promptId - The prompt's id.
   * @param versionNumber - The version's sequential number (1-based, immutable).
   * @returns The version.
   * @throws {acruxcoreError} API_ERROR 404 unknown prompt or version number.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async getVersion(promptId: string, versionNumber: number): Promise<VersionDetail> {
    const response = await this.client._request(
      'GET',
      `/prompts/${encodeURIComponent(promptId)}/versions/${encodeURIComponent(String(versionNumber))}`,
      undefined,
      'fetching prompt version',
    );
    return this.client._parseJsonOrThrow(response, 'fetching prompt version') as Promise<VersionDetail>;
  }

  /**
   * Computes a unified diff between two versions' message content.
   *
   * @param promptId - The prompt's id.
   * @param from - The earlier version's number.
   * @param to - The later version's number. `from === to` is a valid no-op
   *   request — it returns an empty diff, not an error.
   * @returns The unified diff string plus the two version numbers it covers.
   * @throws {acruxcoreError} API_ERROR 404 unknown prompt, or if either version
   *   number doesn't exist.
   * @throws {acruxcoreError} API_ERROR `VALIDATION_ERROR` if `from`/`to` is
   *   missing or not an integer.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async diff(promptId: string, from: number, to: number): Promise<DiffResult> {
    const params = new URLSearchParams({ from: String(from), to: String(to) });
    const response = await this.client._request(
      'GET',
      `/prompts/${encodeURIComponent(promptId)}/versions/diff?${params.toString()}`,
      undefined,
      'diffing prompt versions',
    );
    return this.client._parseJsonOrThrow(response, 'diffing prompt versions') as Promise<DiffResult>;
  }

  /**
   * Promotes an alias to point at a specific version — e.g. rolling `production`
   * forward (or back) to a version already committed. Creates the alias if it
   * does not exist yet.
   *
   * @param promptId - The prompt's id.
   * @param alias - The alias name (e.g. `'production'`, `'staging'`, or a custom one).
   * @param versionNumber - The version to point the alias at.
   * @returns The alias's new state.
   * @throws {acruxcoreError} API_ERROR 404 unknown prompt/version, or 403 if the
   *   caller's role cannot promote (editor and above only).
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async promoteAlias(promptId: string, alias: string, versionNumber: number): Promise<AliasDetail> {
    const response = await this.client._request(
      'POST',
      `/prompts/${encodeURIComponent(promptId)}/aliases/${encodeURIComponent(alias)}/promote`,
      { version_number: versionNumber },
      'promoting prompt alias',
    );
    return this.client._parseJsonOrThrow(response, 'promoting prompt alias') as Promise<AliasDetail>;
  }

  /**
   * Exports one version as a portable JSON document, suitable for {@link importPrompt}
   * (e.g. to copy a prompt into another team or environment).
   *
   * @param promptId - The prompt's id.
   * @param versionNumber - The version to export.
   * @returns The export document (`schemaVersion` is always `1`).
   * @throws {acruxcoreError} API_ERROR 404 unknown prompt or version number.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async exportVersion(promptId: string, versionNumber: number): Promise<ExportedPromptVersion> {
    const response = await this.client._request(
      'GET',
      `/prompts/${encodeURIComponent(promptId)}/versions/${encodeURIComponent(String(versionNumber))}/export`,
      undefined,
      'exporting prompt version',
    );
    return this.client._parseJsonOrThrow(response, 'exporting prompt version') as Promise<ExportedPromptVersion>;
  }

  /**
   * Imports an exported version as a brand-new prompt (version 1) with fresh
   * `production`/`staging` aliases. Never overwrites an existing prompt.
   *
   * @param input - An {@link ExportedPromptVersion}-shaped document (or hand-built
   *   equivalent) with `schemaVersion: 1`.
   * @returns The created prompt + version. `prompt.name` may differ from
   *   `input.prompt.name` on a name collision — the server appends
   *   `-imported-<unix_ms>` rather than rejecting the import.
   * @throws {acruxcoreError} API_ERROR with code `UNSUPPORTED_SCHEMA_VERSION` if
   *   `schemaVersion !== 1`, or `VALIDATION_ERROR` (e.g. empty `version.messages`).
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async importPrompt(input: ImportPromptInput): Promise<ImportPromptResult> {
    const response = await this.client._request('POST', '/prompts/import', input, 'importing prompt');
    return this.client._parseJsonOrThrow(response, 'importing prompt') as Promise<ImportPromptResult>;
  }

  /**
   * Lists traces whose reported `promptVersionId` matches this version — the
   * reverse lookup from a prompt version to what actually ran against it.
   * Reuses the platform's existing traces envelope: the response is
   * byte-identical to `GET /traces`, so this returns the SDK's existing
   * {@link ListTracesResult} rather than a duplicate type.
   *
   * @param promptId - The prompt's id.
   * @param versionNumber - The version to look up traces for.
   * @param options - Pagination (`page` is 1-based).
   * @returns One page of trace summaries; `{ data: [], total: 0, ... }` when the
   *   version has never been called.
   * @throws {acruxcoreError} API_ERROR 404 unknown prompt or version number.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async tracesForVersion(
    promptId: string,
    versionNumber: number,
    options?: PromptVersionTracesOptions,
  ): Promise<ListTracesResult> {
    const params = new URLSearchParams();
    if (options?.page !== undefined) params.set('page', String(options.page));
    if (options?.limit !== undefined) params.set('limit', String(options.limit));

    const qs = params.toString();
    const response = await this.client._request(
      'GET',
      `/prompts/${encodeURIComponent(promptId)}/versions/${encodeURIComponent(String(versionNumber))}/traces${qs ? `?${qs}` : ''}`,
      undefined,
      'listing traces for prompt version',
    );
    return this.client._parseJsonOrThrow(response, 'listing traces for prompt version') as Promise<ListTracesResult>;
  }

  // ── tool bindings ──

  /**
   * Reads every tool binding for a prompt: the default that aliases inherit, plus
   * one entry per prompt alias with the rows that alias owns.
   *
   * An alias with `customised: false` has no rows of its own and calls exactly the
   * `default` list — its own `bindings` array is empty rather than a copy of it.
   *
   * @param promptId - The prompt's id.
   * @returns The default bindings and every prompt alias.
   * @throws {acruxcoreError} API_ERROR with `statusCode` 404 if the prompt doesn't exist.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async listToolBindings(promptId: string): Promise<PromptToolBindings> {
    const response = await this.client._request(
      'GET',
      `/prompts/${encodeURIComponent(promptId)}/tools`,
      undefined,
      'listing prompt tool bindings',
    );
    const body = (await this.client._parseJsonOrThrow(response, 'listing prompt tool bindings')) as {
      data: PromptToolBindings;
    };
    return body.data;
  }

  /**
   * Connects a tool to the prompt as its **default** binding — the one every prompt
   * alias uses unless it has a row of its own. Idempotent: calling it again for the
   * same tool replaces the target rather than adding a second binding.
   *
   * @param promptId - The prompt's id.
   * @param toolId - The catalog tool's id, from `hub.tools.resolve` or the dashboard.
   * @param binding - `{ toolAlias }` to follow a tool alias at use-time, or
   *   `{ pinnedVersionNumber }` to pin one exact tool version. Exactly one.
   * @returns The stored binding, including the tool version it resolves to today.
   * @throws {acruxcoreError} VALIDATION_ERROR if `binding` names neither a tool alias
   *   nor a pinned version (rejected locally, before any request).
   * @throws {acruxcoreError} API_ERROR 404 unknown prompt, tool, tool alias or pinned
   *   version, or 403 if the caller's role cannot bind tools (editor and above only).
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async setToolBinding(
    promptId: string,
    toolId: string,
    binding: ToolBindingInput,
  ): Promise<ToolBindingDetail> {
    const response = await this.client._request(
      'PUT',
      `/prompts/${encodeURIComponent(promptId)}/tools/${encodeURIComponent(toolId)}`,
      bindingBody(binding, false),
      'setting prompt tool binding',
    );
    return this.client._parseJsonOrThrow(response, 'setting prompt tool binding') as Promise<ToolBindingDetail>;
  }

  /**
   * Disconnects a tool from the prompt's default binding, so no alias inheriting the
   * default calls it any more. Per-alias rows for the same tool are left alone — an
   * alias that set its own binding keeps calling the tool.
   *
   * The endpoint replies `204 No Content`, which has no body, so only a non-2xx
   * response is parsed (to get the typed error thrown).
   *
   * @param promptId - The prompt's id.
   * @param toolId - The catalog tool's id.
   * @throws {acruxcoreError} API_ERROR 404 unknown prompt, or if the prompt has no
   *   default binding for that tool; 403 if the caller's role cannot bind tools.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async removeToolBinding(promptId: string, toolId: string): Promise<void> {
    const response = await this.client._request(
      'DELETE',
      `/prompts/${encodeURIComponent(promptId)}/tools/${encodeURIComponent(toolId)}`,
      undefined,
      'removing prompt tool binding',
    );
    if (!response.ok) {
      await this.client._parseJsonOrThrow(response, 'removing prompt tool binding');
    }
  }

  /**
   * Connects a tool for **one prompt alias only**, overriding whatever the default
   * says for that alias. This is how a tool gets rolled out (`dev` gets it first) or
   * runs a different build per environment (`dev` on the tool's `staging` alias).
   *
   * @param promptId - The prompt's id.
   * @param alias - The prompt alias this binding applies to, e.g. `'staging'`.
   * @param toolId - The catalog tool's id.
   * @param binding - `{ toolAlias }`, `{ pinnedVersionNumber }`, or `{ off: true }`
   *   meaning this alias deliberately has no such tool even though the default does.
   *   Exactly one.
   * @returns The stored binding for this alias.
   * @throws {acruxcoreError} VALIDATION_ERROR if `binding` names none of the three
   *   (rejected locally, before any request).
   * @throws {acruxcoreError} API_ERROR 404 unknown prompt, alias, tool, tool alias or
   *   pinned version, or 403 if the caller's role cannot bind tools.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async setAliasToolBinding(
    promptId: string,
    alias: string,
    toolId: string,
    binding: AliasToolBindingInput,
  ): Promise<ToolBindingDetail> {
    const response = await this.client._request(
      'PUT',
      `/prompts/${encodeURIComponent(promptId)}/aliases/${encodeURIComponent(alias)}/tools/${encodeURIComponent(toolId)}`,
      bindingBody(binding, true),
      'setting prompt alias tool binding',
    );
    return this.client._parseJsonOrThrow(
      response,
      'setting prompt alias tool binding',
    ) as Promise<ToolBindingDetail>;
  }

  /**
   * Drops one alias's own binding for a tool, returning that (alias, tool) pair to
   * the prompt's default. It does NOT stop the alias calling the tool — if the
   * default binds it, the alias inherits it again. Use
   * `setAliasToolBinding(..., { off: true })` for that.
   *
   * @param promptId - The prompt's id.
   * @param alias - The prompt alias to return to the default.
   * @param toolId - The catalog tool's id.
   * @throws {acruxcoreError} API_ERROR 404 unknown prompt, or if that alias has no row
   *   of its own for the tool; 403 if the caller's role cannot bind tools.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async removeAliasToolBinding(promptId: string, alias: string, toolId: string): Promise<void> {
    const response = await this.client._request(
      'DELETE',
      `/prompts/${encodeURIComponent(promptId)}/aliases/${encodeURIComponent(alias)}/tools/${encodeURIComponent(toolId)}`,
      undefined,
      'removing prompt alias tool binding',
    );
    if (!response.ok) {
      await this.client._parseJsonOrThrow(response, 'removing prompt alias tool binding');
    }
  }

  /**
   * Drops every binding one prompt alias owns in a single call, returning it
   * wholesale to the prompt's default. Succeeds even when the alias already had no
   * rows of its own — it is a reset, not a delete of a specific row.
   *
   * @param promptId - The prompt's id.
   * @param alias - The prompt alias to reset.
   * @throws {acruxcoreError} API_ERROR 404 unknown prompt, or 403 if the caller's role
   *   cannot bind tools (editor and above only).
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   */
  async resetAliasToolBindings(promptId: string, alias: string): Promise<void> {
    const response = await this.client._request(
      'DELETE',
      `/prompts/${encodeURIComponent(promptId)}/aliases/${encodeURIComponent(alias)}/tools`,
      undefined,
      'resetting prompt alias tool bindings',
    );
    if (!response.ok) {
      await this.client._parseJsonOrThrow(response, 'resetting prompt alias tool bindings');
    }
  }

  // ── render (SWR cache) ──

  /**
   * Renders a stored prompt by name + alias and returns its templated messages
   * plus the tools bound to that alias (OpenAI-shaped). Cached per
   * (name, alias, variables).
   *
   * - On cache hit (fresh): returns cached value immediately, no network call.
   * - On cache hit (stale): returns cached value immediately, fires background refresh.
   * - On cache miss: fetches from API, caches result, returns it.
   * - API unreachable + stale entry: returns stale value, logs warning.
   * - API unreachable + cold cache: throws NETWORK_ERROR after retries.
   *
   * @param name - The prompt name (slug, not ID).
   * @param alias - The alias to resolve (e.g. 'production', 'staging').
   * @param variables - Template variables to pass to the render endpoint.
   * @returns `{ messages, tools }`; `tools` is `[]` when the alias binds none.
   * @throws {acruxcoreError} MISSING_VARIABLES if the template requires variables not supplied.
   * @throws {acruxcoreError} API_ERROR for non-retryable HTTP errors.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable and no stale cache entry exists.
   */
  async render(
    name: string,
    alias: string,
    variables: Record<string, unknown> = {},
  ): Promise<RenderResult> {
    if (this.cacheTtl <= 0) {
      return this._fetchAndCache(name, alias, variables, null);
    }

    const cache = getCache(this.maxCacheSize);
    const cacheKey = `${this.client._apiKeyFingerprint()}:${name}:${alias}:${hashVariables(variables)}`;
    const now = Date.now();

    const cached = cache.get(cacheKey);

    if (cached) {
      const age = now - cached.fetchedAt;
      if (age < this.cacheTtl) {
        return cached.value;
      }

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

  /** @internal */
  private async _fetchAndCache(
    name: string,
    alias: string,
    variables: Record<string, unknown>,
    cacheKey: string | null,
  ): Promise<RenderResult> {
    const response = await this.client._request(
      'POST',
      `/prompts/${encodeURIComponent(name)}/${encodeURIComponent(alias)}/render`,
      { variables },
      `fetching "${name}/${alias}"`,
    );

    if (!response.ok) {
      const body = await response.json().catch(() => undefined);

      if (response.status === 400 && body && typeof body === 'object') {
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

    const data = (await response.json()) as {
      messages: Message[];
      tools?: ToolDefinition[];
      toolResolutions?: ToolResolution[];
      model?: string | null;
      versionId?: string | null;
      versionNumber?: number | null;
    };
    const value: RenderResult = {
      messages: data.messages,
      tools: data.tools ?? [],
      toolResolutions: data.toolResolutions ?? [],
      model: data.model ?? null,
      versionId: data.versionId ?? null,
      versionNumber: data.versionNumber ?? null,
    };

    if (cacheKey !== null) {
      const cache = getCache(this.maxCacheSize);
      cache.set(cacheKey, { value, fetchedAt: Date.now() });
    }

    return value;
  }
}
