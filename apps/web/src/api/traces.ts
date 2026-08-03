import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiQuery } from './client';
import { keys } from './queryClient';
import type {
  AnalyticsParams,
  Feedback,
  FeedbackFeedParams,
  FeedbackSummary,
  FeedbackSummaryParams,
  Paginated,
  PatchFeedbackInput,
  PostFeedbackInput,
  SessionDetail,
  SessionSummary,
  SessionsParams,
  TraceAnalytics,
  TraceDetail,
  TraceFacets,
  TraceFilters,
  TraceListItem,
  TraceSettings,
  UpdateTraceSettingsInput,
} from './types';

/** Maps a camelCase TraceFilters object to the API's snake_case/bracket query params. */
function traceQuery(f: TraceFilters): ApiQuery {
  return {
    from: f.from,
    to: f.to,
    status: f.status,
    model: f.model,
    session_id: f.sessionId,
    prompt_version_id: f.promptVersionId,
    min_latency_ms: f.minLatencyMs,
    min_cost_usd: f.minCostUsd,
    min_tokens: f.minTokens,
    q: f.q,
    tags: f.tags,
    metadata: f.metadata,
    page: f.page,
    limit: f.limit,
  };
}

/**
 * Lists traces (newest first) matching the given filters. The URL is the source of
 * truth for `filters`; the caller parses `useSearchParams` into `TraceFilters`.
 *
 * @param filters - Time/status/model/session/prompt-version/threshold/text/page filters.
 * @returns TanStack query of a paginated `TraceListItem` envelope.
 */
export function useTraces(filters: TraceFilters) {
  const query = traceQuery(filters);
  return useQuery({
    queryKey: keys.traces(query),
    queryFn: () => api<Paginated<TraceListItem>>('/traces', { query }),
  });
}

/**
 * Fetches one trace with its span tree, inline observability, captured payloads,
 * and embedded feedback. Disabled until an id is present.
 *
 * @param id - Trace UUID, or null while the route param is unresolved.
 * @returns TanStack query of `TraceDetail`.
 */
export function useTrace(id: string | null) {
  return useQuery({
    queryKey: keys.trace(id ?? ''),
    queryFn: () => api<TraceDetail>(`/traces/${id}`),
    enabled: !!id,
  });
}

/**
 * Fetches time-series analytics (volume, latency p50/p95/p99, tokens, cost, error rate).
 *
 * @param params - from/to (ISO), groupBy, optional kind + model filters.
 * @returns TanStack query of `TraceAnalytics`.
 */
export function useTraceAnalytics(params: AnalyticsParams) {
  const query = { from: params.from, to: params.to, group_by: params.groupBy, kind: params.kind, model: params.model };
  return useQuery({
    queryKey: keys.traceAnalytics(query),
    queryFn: () => api<TraceAnalytics>('/traces/analytics', { query }),
  });
}

/**
 * Lists sessions with rolled-up totals (newest activity first).
 *
 * @param params - from/to (ISO), optional session-id substring `q`, pagination.
 */
export function useSessions(params: SessionsParams) {
  const query = { from: params.from, to: params.to, q: params.q, page: params.page, limit: params.limit };
  return useQuery({
    queryKey: keys.sessions(query),
    queryFn: () => api<Paginated<SessionSummary>>('/sessions', { query }),
  });
}

/**
 * Fetches one session (summary + its traces). Disabled until an id is present.
 *
 * @param id - The caller-supplied session id string, or null while unresolved.
 */
export function useSession(id: string | null) {
  return useQuery({
    queryKey: keys.session(id ?? ''),
    queryFn: () => api<SessionDetail>(`/sessions/${encodeURIComponent(id ?? '')}`),
    enabled: !!id,
  });
}

/**
 * Reverse lineage: lists traces whose spans used a specific prompt version. Backs an
 * optional per-version view; the primary "View traces" entry uses the `/traces?prompt_version_id=`
 * filter route instead.
 *
 * @param promptId - Prompt UUID (or null while unresolved).
 * @param versionNumber - The version number `:n`.
 * @param page - 1-based page.
 */
export function usePromptVersionTraces(promptId: string | null, versionNumber: number, page = 1) {
  return useQuery({
    queryKey: keys.promptVersionTraces(promptId ?? '', versionNumber, page),
    queryFn: () =>
      api<Paginated<TraceListItem>>(`/prompts/${promptId}/versions/${versionNumber}/traces`, { query: { page } }),
    enabled: !!promptId,
  });
}

/**
 * Reads the team's payload-capture setting (lazily defaulted server-side).
 */
export function useTraceSettings() {
  return useQuery({
    queryKey: keys.traceSettings,
    queryFn: () => api<TraceSettings>('/traces/settings'),
  });
}

/**
 * Toggles payload capture (owner/admin only, enforced server-side). Invalidates the
 * settings query so the switch reflects the persisted value.
 */
export function useUpdateTraceSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateTraceSettingsInput) =>
      api<TraceSettings>('/traces/settings', { method: 'PUT', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.traceSettings }),
  });
}

/**
 * Fetches the team's distinct tags + metadata keys, for populating the trace
 * filter bar's pickers.
 */
export function useTraceFacets() {
  return useQuery({
    queryKey: keys.traceFacets,
    queryFn: () => api<TraceFacets>('/traces/facets'),
  });
}

/**
 * Fetches the team's distinct values for one metadata key. Disabled until a key
 * is chosen.
 *
 * @param key - The metadata key to enumerate values for, or null while unchosen.
 */
export function useTraceFacetValues(key: string | null) {
  return useQuery({
    queryKey: keys.traceFacetValues(key ?? ''),
    queryFn: () => api<{ values: string[] }>('/traces/facets/values', { query: { key: key ?? '' } }),
    enabled: !!key,
  });
}

/**
 * Posts feedback to a trace (or a span within it). Invalidates `keys.trace(traceId)`
 * so the detail's embedded `feedback[]` refetches and the panel updates.
 *
 * @param traceId - The trace the feedback attaches to.
 */
export function usePostFeedback(traceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PostFeedbackInput) =>
      api<Feedback>(`/traces/${traceId}/feedback`, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.trace(traceId) }),
  });
}

/**
 * Edits an existing feedback row in place (author-only, enforced server-side).
 * Invalidates `keys.trace(traceId)` the same way {@link usePostFeedback} does.
 *
 * @param traceId - The trace the feedback belongs to.
 */
export function usePatchFeedback(traceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ feedbackId, body }: { feedbackId: string; body: PatchFeedbackInput }) =>
      api<Feedback>(`/traces/${traceId}/feedback/${feedbackId}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.trace(traceId) }),
  });
}

/**
 * Fetches the avg-rating + counts summary grouped by prompt version (default) or model.
 *
 * @param params - Optional from/to (ISO) and groupBy; defaults to the last 30 days server-side.
 */
export function useFeedbackSummary(params: FeedbackSummaryParams = {}) {
  const query = { from: params.from, to: params.to, group_by: params.groupBy };
  return useQuery({
    queryKey: keys.feedbackSummary(query),
    queryFn: () => api<FeedbackSummary>('/traces/feedback/summary', { query }),
  });
}

/**
 * Fetches the team-wide raw feedback feed (T10), newest-first, paginated — the
 * browsable list behind the feedback visualization page.
 *
 * @param params - page/limit; defaults to page 1, the server's default limit.
 */
export function useFeedbackFeed(params: FeedbackFeedParams = {}) {
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  return useQuery({
    queryKey: keys.feedbackFeed(page, limit),
    queryFn: () => api<Paginated<Feedback>>('/traces/feedback', { query: { page, limit } }),
  });
}
