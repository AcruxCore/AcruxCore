import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { keys } from './queryClient';
import type {
  CommitToolVersionInput,
  CreateToolInput,
  ExecuteResult,
  ExecuteToolInput,
  Paginated,
  ToolAlias,
  ToolDetail,
  ToolStat,
  ToolSummary,
  ToolVersion,
  ToolVersionListItem,
} from './types';

/** List the team's tools (newest first, paginated by the API). Any role. */
export function useTools() {
  return useQuery({
    queryKey: keys.tools,
    queryFn: () => api<Paginated<ToolSummary>>('/tools'),
  });
}

/** Fetch one tool's mutable shell (name/description) by id. */
export function useTool(id: string) {
  return useQuery({
    queryKey: keys.tool(id),
    queryFn: () => api<ToolDetail>(`/tools/${id}`),
    enabled: !!id,
  });
}

/** List a tool's versions (metadata only — no schema/executor payload). */
export function useToolVersions(id: string) {
  return useQuery({
    queryKey: keys.toolVersions(id),
    queryFn: () => api<Paginated<ToolVersionListItem>>(`/tools/${id}/versions`),
    enabled: !!id,
  });
}

/**
 * Fetch one tool version in full (parametersSchema + executor), unlike the
 * list which omits those. Used to prefill the New-version dialog from the
 * latest version. Disabled when `versionNumber` is null (e.g. no versions yet).
 */
export function useToolVersion(toolId: string, versionNumber: number | null) {
  return useQuery({
    queryKey: keys.toolVersion(toolId, versionNumber ?? 0),
    queryFn: () => api<ToolVersion>(`/tools/${toolId}/versions/${versionNumber}`),
    enabled: !!toolId && versionNumber != null,
  });
}

/** List a tool's resolved aliases (e.g. `production`) with their target version numbers. */
export function useToolAliases(id: string) {
  return useQuery({
    queryKey: keys.toolAliases(id),
    queryFn: () => api<{ data: ToolAlias[] }>(`/tools/${id}/aliases`),
    enabled: !!id,
  });
}

/** Create a tool shell (owner/admin/editor). */
export function useCreateTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateToolInput) => api<ToolSummary>('/tools', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.tools }),
  });
}

/** Commit a new immutable tool version (parameters schema + executor). */
export function useCommitToolVersion(toolId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CommitToolVersionInput) =>
      api<ToolVersion>(`/tools/${toolId}/versions`, { method: 'POST', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.toolVersions(toolId) });
      qc.invalidateQueries({ queryKey: keys.toolAliases(toolId) });
    },
  });
}

/** Promote (or roll back) an alias to point at a given version number. */
export function usePromoteToolAlias(toolId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ alias, versionNumber }: { alias: string; versionNumber: number }) =>
      api<ToolAlias>(`/tools/${toolId}/aliases/${alias}/promote`, {
        method: 'POST',
        body: { version_number: versionNumber },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.toolAliases(toolId) }),
  });
}

/**
 * Imperative (non-hook) execute call, for the playground tool-calling loop,
 * which drives multiple sequential completions outside React's render cycle.
 *
 * @param toolId - The tool's id (not name — the loop resolves name → id first).
 * @param body - Call arguments plus an optional alias/versionNumber pin.
 * @returns The tool's result payload, HTTP status, and latency.
 * @throws {ApiError} On any non-2xx response (e.g. executor error, 404 tool).
 */
export function executeTool(toolId: string, body: ExecuteToolInput): Promise<ExecuteResult> {
  return api<ExecuteResult>(`/tools/${toolId}/execute`, { method: 'POST', body });
}

/**
 * Fetches per-tool call-analytics (calls, error rate, p50/p95 latency), aggregated
 * from tool spans (TC4). Team-scoped and windowed server-side.
 *
 * @returns TanStack query of `{ data: ToolStat[] }`.
 */
export function useToolAnalytics() {
  return useQuery({ queryKey: keys.toolAnalytics, queryFn: () => api<{ data: ToolStat[] }>('/tools/analytics') });
}
