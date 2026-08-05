import type {
  AnalyticsOptions,
  AnalyticsResult,
  FacetValuesResult,
  FeedbackInput,
  FeedbackListResult,
  FeedbackResult,
  FeedbackSummaryOptions,
  FeedbackSummaryResult,
  FeedbackUpdateInput,
  GetTraceResult,
  ListFeedbackOptions,
  ListTracesOptions,
  ListTracesResult,
  TraceFacets,
  TraceFeedbackResult,
  TraceInput,
  TraceResult,
  TraceSettings,
} from './types';
import type { NamespaceHost } from './host';

/**
 * The subset of the client this namespace needs.
 *
 * Declared structurally rather than importing `acruxcore`, which would be a runtime
 * circular import: the client constructs this namespace.
 */
export type TracesNamespaceHost = NamespaceHost;

/**
 * Trace-domain-wide reads — analytics, facet discovery, payload-capture settings,
 * and feedback summary/list — reached as `hub.traces`.
 *
 * Held as a separate object rather than more flat methods on `acruxcore` so the
 * client's surface stays readable as this domain grows. The existing flat
 * `trace`/`getTrace`/`listTraces`/`submitFeedback`/`updateFeedback` methods stay
 * on `acruxcore` itself — this namespace is purely additive.
 */
export class TracesNamespace {
  private readonly client: TracesNamespaceHost;

  /**
   * @param client - The owning client, used for its request/parse helpers.
   */
  constructor(client: TracesNamespaceHost) {
    this.client = client;
  }

  /**
   * Aggregate volume / error-rate / token / cost / latency metrics over every
   * span (gateway completions AND SDK-reported spans — a superset of the
   * gateway-only usage numbers). Wraps `GET /traces/analytics`.
   *
   * @param options - Optional date range, grouping dimension, and kind/model
   *   filters. When omitted, the window defaults to the last 30 days and
   *   grouping defaults to `'day'` (both server-side defaults, not repeated here).
   * @returns Totals across the resolved window plus one bucket per group key.
   *   A bucket whose group key is null (e.g. a span with no model) is omitted
   *   from `buckets` but its span is still counted in `totals`.
   * @throws {acruxcoreError} API_ERROR — 400 `VALIDATION_ERROR` for an invalid
   *   `groupBy`/`kind`, an unparseable `from`/`to`, or `from` after `to`.
   */
  async analytics(options?: AnalyticsOptions): Promise<AnalyticsResult> {
    const params = new URLSearchParams();
    if (options?.from !== undefined) params.set('from', options.from);
    if (options?.to !== undefined) params.set('to', options.to);
    if (options?.groupBy !== undefined) params.set('group_by', options.groupBy);
    if (options?.kind !== undefined) params.set('kind', options.kind);
    if (options?.model !== undefined) params.set('model', options.model);

    const qs = params.toString();
    const response = await this.client._request(
      'GET',
      `/traces/analytics${qs ? `?${qs}` : ''}`,
      undefined,
      'reading trace analytics',
    );
    return (await this.client._parseJsonOrThrow(response, 'reading trace analytics')) as AnalyticsResult;
  }

  /**
   * The team's distinct tags and metadata keys, for populating filter pickers.
   * Wraps `GET /traces/facets`.
   *
   * @returns `{ tags, metadataKeys }`, each alphabetical.
   * @throws {acruxcoreError} API_ERROR for a non-2xx response.
   */
  async listFacets(): Promise<TraceFacets> {
    const response = await this.client._request('GET', '/traces/facets', undefined, 'listing trace facets');
    return (await this.client._parseJsonOrThrow(response, 'listing trace facets')) as TraceFacets;
  }

  /**
   * The team's distinct values for one metadata key. Wraps
   * `GET /traces/facets/values`.
   *
   * @param key - The metadata key to enumerate values for. Always required —
   *   there is no "list every key's values" mode.
   * @returns `{ values }`, alphabetical. Note the response carries no `key`
   *   field — only `values`.
   * @throws {acruxcoreError} API_ERROR — 400 `VALIDATION_ERROR` ("key is
   *   required.") when `key` is an empty string.
   */
  async getFacetValues(key: string): Promise<FacetValuesResult> {
    const response = await this.client._request(
      'GET',
      `/traces/facets/values?key=${encodeURIComponent(key)}`,
      undefined,
      'reading trace facet values',
    );
    return (await this.client._parseJsonOrThrow(response, 'reading trace facet values')) as FacetValuesResult;
  }

  /**
   * Reads the team's trace payload-capture default. Wraps `GET /traces/settings`.
   *
   * @returns `{ capturePayloads, updatedAt }`. `updatedAt` is null until the
   *   team's settings row has ever been written — the lazy default it reads back
   *   as is `{ capturePayloads: true, updatedAt: null }`.
   * @throws {acruxcoreError} API_ERROR for a non-2xx response.
   */
  async getSettings(): Promise<TraceSettings> {
    const response = await this.client._request('GET', '/traces/settings', undefined, 'reading trace settings');
    return (await this.client._parseJsonOrThrow(response, 'reading trace settings')) as TraceSettings;
  }

  /**
   * Toggles the team's trace payload-capture default. Wraps `PUT /traces/settings`.
   *
   * @param capturePayloads - The new default. A single boolean, not an options
   *   object, since the endpoint takes exactly this one field.
   * @returns The updated settings, with `updatedAt` now a real timestamp.
   * @throws {acruxcoreError} API_ERROR — 400 `VALIDATION_ERROR` if the body is
   *   not a boolean; 403 `TEAM_KEY_NOT_PERMITTED` when the caller is a
   *   team-scoped API key (no user identity); 403 `FORBIDDEN` when the caller
   *   is a personal key/session belonging to a non-owner/admin member — a
   *   personal key minted by an owner/admin succeeds.
   */
  async updateSettings(capturePayloads: boolean): Promise<TraceSettings> {
    const response = await this.client._request(
      'PUT',
      '/traces/settings',
      { capturePayloads },
      'updating trace settings',
    );
    return (await this.client._parseJsonOrThrow(response, 'updating trace settings')) as TraceSettings;
  }

  /**
   * Average rating and counts grouped by prompt version or model. Wraps
   * `GET /traces/feedback/summary`.
   *
   * @param options - Optional date range and grouping dimension. When omitted,
   *   the window defaults to the last 30 days and grouping defaults to
   *   `'prompt_version'` (server-side defaults).
   * @returns `{ groupBy, buckets }`. A group key with no feedback yet is simply
   *   absent from `buckets`, never a zeroed entry.
   * @throws {acruxcoreError} API_ERROR — 400 `VALIDATION_ERROR` for an invalid
   *   `groupBy` or an unparseable `from`/`to`.
   */
  async getFeedbackSummary(options?: FeedbackSummaryOptions): Promise<FeedbackSummaryResult> {
    const params = new URLSearchParams();
    if (options?.from !== undefined) params.set('from', options.from);
    if (options?.to !== undefined) params.set('to', options.to);
    if (options?.groupBy !== undefined) params.set('group_by', options.groupBy);

    const qs = params.toString();
    const response = await this.client._request(
      'GET',
      `/traces/feedback/summary${qs ? `?${qs}` : ''}`,
      undefined,
      'reading feedback summary',
    );
    return (await this.client._parseJsonOrThrow(response, 'reading feedback summary')) as FeedbackSummaryResult;
  }

  /**
   * Team-wide feedback feed, newest-first, paginated. Wraps `GET /traces/feedback`.
   *
   * @param options - Optional `page`/`limit` (limit capped at 100 server-side).
   * @returns `{ data, total, page, limit }` — every feedback row across the team,
   *   not scoped to one trace (see {@link getTraceFeedback} for that).
   * @throws {acruxcoreError} API_ERROR for a non-2xx response.
   */
  async listFeedback(options?: ListFeedbackOptions): Promise<FeedbackListResult> {
    const params = new URLSearchParams();
    if (options?.page !== undefined) params.set('page', String(options.page));
    if (options?.limit !== undefined) params.set('limit', String(options.limit));

    const qs = params.toString();
    const response = await this.client._request(
      'GET',
      `/traces/feedback${qs ? `?${qs}` : ''}`,
      undefined,
      'listing feedback',
    );
    return (await this.client._parseJsonOrThrow(response, 'listing feedback')) as FeedbackListResult;
  }

  /**
   * Every feedback row for one trace. Wraps `GET /traces/:id/feedback`.
   *
   * @param traceId - The trace to read feedback for.
   * @returns `{ data }` — an unpaginated, full list for this one trace. This is
   *   a DIFFERENT envelope shape from {@link listFeedback}'s `{ data, total,
   *   page, limit }`, despite both returning the same row shape: there is no
   *   `total`/`page`/`limit` here.
   * @throws {acruxcoreError} API_ERROR for a non-2xx response.
   */
  async getTraceFeedback(traceId: string): Promise<TraceFeedbackResult> {
    const response = await this.client._request(
      'GET',
      `/traces/${encodeURIComponent(traceId)}/feedback`,
      undefined,
      'reading trace feedback',
    );
    return (await this.client._parseJsonOrThrow(response, 'reading trace feedback')) as TraceFeedbackResult;
  }

  // ── Trace CRUD (moved from flat client methods) ──

  /**
   * Reports a trace (a group of spans) to acruxcore. A single-trace convenience
   * over the batch endpoint. Omit `input.traceId` to mint a new trace; pass a
   * traceId returned by a prior call to append spans to that same trace.
   *
   * @param input - The trace and its spans to report.
   * @returns The resolved `{ traceId }`.
   * @throws {acruxcoreError} NETWORK_ERROR if the API is unreachable after retries.
   * @throws {acruxcoreError} API_ERROR for a non-2xx response.
   */
  async ingest(input: TraceInput): Promise<TraceResult> {
    const response = await this.client._request(
      'POST',
      '/traces',
      { traces: [input] } as unknown as Record<string, unknown>,
      'reporting trace',
    );
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw new (await import('./error')).acruxcoreError(
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
   * Reads back a full trace: its header plus every span assembled into a
   * parent/child tree. Wraps `GET /traces/:id`.
   *
   * @param traceId - The trace id.
   * @returns The trace header and its span tree.
   * @throws {acruxcoreError} API_ERROR with statusCode 404 if the trace doesn't exist.
   */
  async get(traceId: string): Promise<GetTraceResult> {
    const response = await this.client._request(
      'GET',
      `/traces/${encodeURIComponent(traceId)}`,
      undefined,
      'reading trace',
    );
    return this.client._parseJsonOrThrow(response, 'reading trace') as Promise<GetTraceResult>;
  }

  /**
   * Lists traces, newest first, with optional filters. Wraps `GET /traces`.
   *
   * @param options - Optional filters and pagination.
   * @returns One page of trace summaries.
   * @throws {acruxcoreError} On a non-2xx response.
   */
  async list(options: ListTracesOptions = {}): Promise<ListTracesResult> {
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
    const response = await this.client._request('GET', `/traces${qs ? `?${qs}` : ''}`, undefined, 'listing traces');
    return this.client._parseJsonOrThrow(response, 'listing traces') as Promise<ListTracesResult>;
  }

  /**
   * Attaches feedback (rating and/or label and/or comment) to a trace, or to one
   * span within it. Wraps `POST /traces/:id/feedback`.
   *
   * @param input - The traceId plus at least one of rating/label/comment.
   * @returns The created feedback row.
   * @throws {acruxcoreError} API_ERROR for a non-2xx response.
   */
  async submitFeedback(input: FeedbackInput): Promise<FeedbackResult> {
    const { traceId, ...body } = input;
    const response = await this.client._request(
      'POST',
      `/traces/${encodeURIComponent(traceId)}/feedback`,
      body as unknown as Record<string, unknown>,
      'submitting feedback',
    );
    return this.client._parseJsonOrThrow(response, 'submitting feedback') as Promise<FeedbackResult>;
  }

  /**
   * Edits a feedback row's rating/label/comment in place. Only the row's
   * original author may edit it. Wraps `PATCH /traces/:id/feedback/:feedbackId`.
   *
   * @param input - traceId, feedbackId, and the fields to change.
   * @returns The updated feedback row.
   * @throws {acruxcoreError} API_ERROR for a non-2xx response.
   */
  async updateFeedback(input: FeedbackUpdateInput): Promise<FeedbackResult> {
    const { traceId, feedbackId, ...body } = input;
    const response = await this.client._request(
      'PATCH',
      `/traces/${encodeURIComponent(traceId)}/feedback/${encodeURIComponent(feedbackId)}`,
      body as unknown as Record<string, unknown>,
      'updating feedback',
    );
    return this.client._parseJsonOrThrow(response, 'updating feedback') as Promise<FeedbackResult>;
  }
}
