import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Budget,
  ChatCompletion,
  ChatMessage,
  CreateBudgetInput,
  CreateConnectionInput,
  CreateModelInput,
  CreateVirtualKeyInput,
  GatewayMeta,
  GatewayModel,
  GatewayRequestItem,
  ModelTestResult,
  Paginated,
  ProviderConnection,
  ToolDefinition,
  UpdateBudgetInput,
  UpdateConnectionInput,
  UpdateModelInput,
  UpdateVirtualKeyInput,
  UsageGroupBy,
  UsageResponse,
  VirtualKeyCreated,
  VirtualKeyListItem,
} from './types';
import { api } from './client';
import { keys } from './queryClient';

/**
 * The two raw `fetch` calls below bypass {@link api} because they need response
 * headers and SSE streaming. They authenticate the same way everything else does
 * — the browser attaches the httpOnly session cookie — so they only have to opt
 * in to sending credentials, which `same-origin` does. There is no token for this
 * layer to fetch or forward any more.
 */
const CREDENTIALS: RequestCredentials = 'same-origin';

// ── Provider connections (BYOK) ─────────────────────────────────────────────

/** List the team's provider connections (masked), newest first. Any role. */
export function useConnections() {
  return useQuery({
    queryKey: keys.connections,
    queryFn: () => api<ProviderConnection[]>('/gateway/connections'),
  });
}

/** Create a provider connection (owner/admin). Plaintext key is stored encrypted. */
export function useCreateConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateConnectionInput) =>
      api<ProviderConnection>('/gateway/connections', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.connections }),
  });
}

/** Update a connection's label/config or rotate its key (owner/admin). */
export function useUpdateConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateConnectionInput }) =>
      api<ProviderConnection>(`/gateway/connections/${id}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.connections }),
  });
}

/** Delete a connection (owner/admin). */
export function useDeleteConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/gateway/connections/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.connections }),
  });
}

// ── Model registry ──────────────────────────────────────────────────────────

/** List the team's registered models (with credential label + fallbacks). Any role. */
export function useModels() {
  return useQuery({
    queryKey: keys.models,
    queryFn: () => api<GatewayModel[]>('/gateway/models'),
  });
}

/** Register a model (owner/admin). */
export function useCreateModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateModelInput) =>
      api<GatewayModel>('/gateway/models', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.models }),
  });
}

/** Update a model in place — keeps the public name (owner/admin). */
export function useUpdateModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateModelInput }) =>
      api<GatewayModel>(`/gateway/models/${id}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.models }),
  });
}

/** Delete a model (owner/admin). 409 if it is another model's fallback. */
export function useDeleteModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/gateway/models/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.models }),
  });
}

/** Fire a diagnostic 1-token completion through a model (owner/admin). */
export function useTestModel() {
  return useMutation({
    mutationFn: (id: string) =>
      api<ModelTestResult>(`/gateway/models/${id}/test`, { method: 'POST' }),
  });
}

// ── Virtual keys ────────────────────────────────────────────────────────────

/** List the team's virtual keys (masked, active + revoked). Any role. */
export function useVirtualKeys() {
  return useQuery({
    queryKey: keys.virtualKeys,
    queryFn: () => api<VirtualKeyListItem[]>('/gateway/keys'),
  });
}

/** Create a virtual key (owner/admin); the plaintext token is returned once. */
export function useCreateVirtualKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateVirtualKeyInput) =>
      api<VirtualKeyCreated>('/gateway/keys', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.virtualKeys }),
  });
}

/** Update a virtual key's name/scopes/limits (owner/admin). */
export function useUpdateVirtualKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateVirtualKeyInput }) =>
      api<VirtualKeyListItem>(`/gateway/keys/${id}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.virtualKeys }),
  });
}

/** Soft-revoke a virtual key (owner/admin). */
export function useRevokeVirtualKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/gateway/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.virtualKeys }),
  });
}

// ── Budgets ───────────────────────────────────────────────────────────────--

/** List the team's budgets with live spend (any role). */
export function useBudgets() {
  return useQuery({
    queryKey: keys.budgets,
    queryFn: () => api<Budget[]>('/gateway/budgets'),
  });
}

/** Create a spend cap (owner/admin). Duplicate scope+period → 409 BUDGET_EXISTS. */
export function useCreateBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBudgetInput) =>
      api<Budget>('/gateway/budgets', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.budgets }),
  });
}

/** Update a budget's limit and/or period (owner/admin). */
export function useUpdateBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateBudgetInput }) =>
      api<Budget>(`/gateway/budgets/${id}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.budgets }),
  });
}

/** Delete a budget (owner/admin). */
export function useDeleteBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/gateway/budgets/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.budgets }),
  });
}

// ── Response cache ────────────────────────────────────────────────────────--

/** Flush the team's response cache (owner/admin). Returns rows removed. */
export function useFlushCache() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ deleted: number }>('/gateway/cache', { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gateway-usage'] }),
  });
}

// ── Usage & request log (read-only analytics) ───────────────────────────────

export interface UsageParams {
  from: string;
  to: string;
  groupBy: UsageGroupBy;
  virtualKeyId?: string;
}

/** Aggregate usage over a date window, grouped by day/model/provider/virtual_key. */
export function useUsage(params: UsageParams) {
  const { from, to, groupBy, virtualKeyId } = params;
  return useQuery({
    queryKey: keys.usage(from, to, groupBy, virtualKeyId),
    queryFn: () =>
      api<UsageResponse>('/gateway/usage', {
        query: { from, to, group_by: groupBy, virtual_key_id: virtualKeyId },
      }),
  });
}

export interface RequestLogParams {
  page?: number;
  limit?: number;
  model?: string;
  status?: string;
  virtualKeyId?: string;
}

/** The paginated gateway request log, newest first. Any role. */
export function useGatewayRequests(params: RequestLogParams) {
  const query: Record<string, string | number | undefined> = {
    page: params.page,
    limit: params.limit,
    model: params.model,
    status: params.status,
    virtual_key_id: params.virtualKeyId,
  };
  return useQuery({
    queryKey: keys.gatewayRequests(query),
    queryFn: () => api<Paginated<GatewayRequestItem>>('/gateway/requests', { query }),
  });
}

/** A single request-log row by id (404 if unknown or another team's). */
export function useGatewayRequest(id: string | null) {
  return useQuery({
    queryKey: keys.gatewayRequest(id ?? ''),
    queryFn: () => api<GatewayRequestItem>(`/gateway/requests/${id}`),
    enabled: !!id,
  });
}

// ── Chat completions (raw fetch: captures headers + supports streaming) ──────

/** Parse the `x-gateway-*` telemetry headers from a completion response. */
function readMeta(res: Response): GatewayMeta {
  const cost = res.headers.get('x-gateway-cost-usd');
  return {
    requestId: res.headers.get('x-gateway-request-id'),
    provider: res.headers.get('x-gateway-provider'),
    model: res.headers.get('x-gateway-model'),
    costUsd: cost === '' ? null : cost,
    cache: res.headers.get('x-gateway-cache'),
    rateLimitRemaining: res.headers.get('x-gateway-ratelimit-remaining'),
  };
}

/** The request body accepted by the completion endpoint, in either mode. */
export interface CompletionBody {
  model: string;
  messages?: ChatMessage[];
  prompt?: { name: string; alias: string; variables?: Record<string, unknown> };
  /** Top-level render variables — opt-in ad-hoc templating of `messages` (gateway-side). */
  variables?: Record<string, unknown>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  /** Inline OpenAI-shaped tool definitions available to the model this turn. */
  tools?: ToolDefinition[];
  /** Tool-usage control: force/forbid/allow tool calls (defaults to `auto` on the gateway). */
  tool_choice?: 'auto' | 'none' | 'required';
  /** Catalog references — resolved to `ToolDefinition`s and merged into `tools` server-side. */
  tool_refs?: { name: string; alias?: string }[];
}

export interface CompletionResult {
  meta: GatewayMeta;
  completion: ChatCompletion;
  latencyMs: number;
}

/**
 * Trace correlation for a completion. Supplying a `traceId` groups this call's
 * span into an existing trace (the gateway creates it honoring the id on the
 * first call, then appends on later calls) — the Playground's tool loop uses
 * this to fold its several round-trips into one trace. `traceName` names that
 * trace so it doesn't fall back to an ISO-timestamp label.
 */
export interface TraceContext {
  traceId?: string;
  traceName?: string;
}

/**
 * Call the gateway once (non-streaming) and return the parsed body plus the
 * `x-gateway-*` telemetry headers and measured round-trip latency.
 *
 * @param body - The completion request body.
 * @param trace - Optional trace correlation (see {@link TraceContext}).
 * @throws {Error} with the API `error.message` on any non-2xx response.
 */
export async function gatewayComplete(
  body: CompletionBody,
  trace?: TraceContext,
): Promise<CompletionResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (trace?.traceId) headers['x-trace-id'] = trace.traceId;
  // Percent-encode: HTTP header values must be ISO-8859-1, but a trace name is
  // free text (often the user's message) and may contain any Unicode — an
  // em-dash or non-Latin script would make `fetch` throw. The server decodes.
  if (trace?.traceName) headers['x-trace-name'] = encodeURIComponent(trace.traceName);
  const started = performance.now();
  const res = await fetch('/api/v1/gateway/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, stream: false }),
    credentials: CREDENTIALS,
  });
  const latencyMs = Math.round(performance.now() - started);
  const meta = readMeta(res);
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = (data && data.error) || {};
    throw new Error(err.message || `Request failed (${res.status})`);
  }
  return { meta, completion: data as ChatCompletion, latencyMs };
}

/** The rendered form of a stored prompt: concrete messages plus its attached tools. */
export interface RenderedPrompt {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
}

/**
 * Render a stored prompt to concrete messages (variables applied server-side)
 * plus its version's attached tools. Used by the Playground's tool-calling loop
 * to turn an untouched `{name, alias}` prompt reference into the raw message list
 * the client-side loop needs to append tool turns across iterations.
 *
 * @param name - The prompt name.
 * @param alias - The alias to resolve (e.g. `production`).
 * @param variables - Template variables to interpolate.
 * @returns The rendered messages and the attached tools.
 * @throws {ApiError} on a non-2xx response (e.g. 400 with `missing[]` variables).
 */
export async function renderStoredPrompt(
  name: string,
  alias: string,
  variables: Record<string, unknown> = {},
): Promise<RenderedPrompt> {
  return api<RenderedPrompt>(`/prompts/${encodeURIComponent(name)}/${encodeURIComponent(alias)}/render`, {
    method: 'POST',
    body: { variables },
  });
}

export interface StreamHandlers {
  /** Fired once, as soon as response headers arrive (telemetry, minus cost). */
  onMeta?: (meta: GatewayMeta) => void;
  /** Fired for each content delta as it streams in. */
  onDelta: (text: string) => void;
}

/**
 * Call the gateway with `stream: true` and drive the SSE frames, invoking
 * `onDelta` per token. Resolves when the stream terminates (`data: [DONE]`).
 *
 * @throws {Error} on a non-2xx response or a mid-stream `error` frame.
 */
export async function gatewayStream(
  body: CompletionBody,
  handlers: StreamHandlers,
): Promise<void> {
  const streamHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  const res = await fetch('/api/v1/gateway/chat/completions', {
    method: 'POST',
    headers: streamHeaders,
    body: JSON.stringify({ ...body, stream: true }),
    credentials: CREDENTIALS,
  });

  if (!res.ok) {
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    throw new Error(data?.error?.message || `Request failed (${res.status})`);
  }
  handlers.onMeta?.(readMeta(res));

  const reader = res.body?.getReader();
  if (!reader) throw new Error('Streaming is not supported in this browser.');
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const chunk = JSON.parse(payload);
        if (chunk.error) throw new Error(chunk.error.message || 'Stream error');
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) handlers.onDelta(delta);
      } catch (e) {
        if (e instanceof Error && e.message !== 'Stream error') {
          // Ignore JSON parse hiccups on partial frames; rethrow real errors.
          if (payload.includes('"error"')) throw e;
        } else {
          throw e;
        }
      }
    }
  }
}
