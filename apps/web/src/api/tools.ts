import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { fetchAllPages } from './paging';
import { keys } from './queryClient';
import type {
  CommitToolVersionInput,
  ExecuteResult,
  ExecuteToolInput,
  Paginated,
  ToolAlias,
  ToolDetail,
  ToolStat,
  ToolSummary,
  ToolVersion,
  ToolVersionListItem,
  UpdateToolInput,
} from './types';

/**
 * Every tool the team owns, newest first. Any role.
 *
 * Reads all pages rather than the API's first-page default. Callers resolve bindings and
 * picker entries against this list by id, so a truncated one does not look like a short
 * list — it looks like the missing tools were deleted.
 */
export function useTools() {
  return useQuery({
    queryKey: keys.tools,
    queryFn: () =>
      fetchAllPages<ToolSummary>(
        (page, limit) => api<Paginated<ToolSummary>>(`/tools?page=${page}&limit=${limit}`),
        'GET /tools',
      ),
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

/**
 * Every version of a tool, metadata only — no schema or executor payload.
 *
 * All pages, for the same reason as {@link useTools}: the version list is what the
 * promote control offers, and stopping at the API's default page would quietly make the
 * oldest versions of a long-lived tool impossible to roll back to.
 */
export function useToolVersions(id: string) {
  return useQuery({
    queryKey: keys.toolVersions(id),
    queryFn: () =>
      fetchAllPages<ToolVersionListItem>(
        (page, limit) => api<Paginated<ToolVersionListItem>>(`/tools/${id}/versions?page=${page}&limit=${limit}`),
        `GET /tools/${id}/versions`,
      ),
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

/** What {@link useCreateToolWithVersion} needs: the shell's name, then its first version. */
export interface CreateToolWithVersionInput {
  name: string;
  /**
   * Sent on both writes: `{ name, description }` on the shell POST, and `description` on
   * the version. They are the same field in the dialog — one Description input — but two
   * different rows read it. The shell's copy is the catalog subtitle (`ToolsPage`), the
   * detail header, and what `filterTools` searches; it is also the model-facing fallback
   * a later version falls back to when its own `description` is blank
   * (`prompt-tool-resolver`'s `version.description ?? toolDescription`). Sending it only
   * to the version, as this used to, left every dashboard-created tool's shell
   * description null forever — nothing else re-sends it after creation.
   */
  description?: string;
  version: CommitToolVersionInput;
  /**
   * A shell created by a previous attempt whose version commit failed. Passing it back
   * commits onto that tool instead of creating a second one — the name is already taken,
   * so a plain retry would fail with `TOOL_NAME_TAKEN` and strand the shell for good.
   */
  existingToolId?: string;
}

/** Which of the two writes failed, so the caller can say something true about the state. */
export type CreateToolStage = 'shell' | 'version';

/** A failure from {@link useCreateToolWithVersion}, carrying the stage and any created shell. */
export class CreateToolError extends Error {
  constructor(
    readonly stage: CreateToolStage,
    readonly cause: unknown,
    /** Set when the shell was created and only the version commit failed. */
    readonly toolId?: string,
  ) {
    super(cause instanceof Error ? cause.message : 'Could not create the tool.');
    this.name = 'CreateToolError';
  }
}

/**
 * Creates a tool and commits its first version.
 *
 * Two writes, because that is the API — but one act, because a tool without a version is
 * not a tool: it resolves to nothing, and every list used to render it as though it
 * worked. Keeping the sequence here rather than in the dialog is what makes the version
 * commit reach the id the create call just returned; a `useCommitToolVersion(id)` bound
 * to component state still holds the previous render's empty id when both run in one
 * handler.
 *
 * The name is claimed first because it is the write that can conflict. If the version
 * then fails, the shell survives and comes back on the error, so a retry commits onto it
 * instead of colliding with the name it just took.
 */
export function useCreateToolWithVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, description, version, existingToolId }: CreateToolWithVersionInput) => {
      let toolId = existingToolId;
      if (!toolId) {
        try {
          const tool = await api<ToolSummary>('/tools', {
            method: 'POST',
            body: { name, ...(description ? { description } : {}) },
          });
          toolId = tool.id;
        } catch (e) {
          throw new CreateToolError('shell', e);
        }
      }
      try {
        await api<ToolVersion>(`/tools/${toolId}/versions`, { method: 'POST', body: version });
      } catch (e) {
        throw new CreateToolError('version', e, toolId);
      }
      return { toolId };
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.tools }),
  });
}

/**
 * Rename a tool or change its catalog description (owner/admin/editor).
 *
 * A rename changes the name the model is shown and the name every `tool_ref` looks up,
 * so callers pinned to the old name stop resolving. The dialog says so before saving.
 */
export function useUpdateTool(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateToolInput) => api<ToolDetail>(`/tools/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.tool(id) });
      qc.invalidateQueries({ queryKey: keys.tools });
    },
  });
}

/**
 * Soft-delete a tool (owner/admin/editor). Versions and history are kept, and every
 * prompt binding to it stops resolving immediately — a deleted tool must stop reaching
 * the model without anyone having to unbind it first.
 */
export function useDeleteTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/tools/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      // Drop this tool's own queries rather than invalidating them. The detail page is
      // still mounted for the moment it takes to navigate away, and an invalidation
      // would refetch three endpoints that now 404 — three console errors for a delete
      // that worked.
      qc.removeQueries({ queryKey: keys.tool(id) });
      qc.removeQueries({ queryKey: keys.toolVersions(id) });
      qc.invalidateQueries({ queryKey: keys.tools });
    },
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
      // Readiness (`callable`, `executorType`, …) lives on the tool resource
      // (`keys.tool(id)`/`keys.tools`), not on the versions list — invalidating only the
      // keys above never reaches it, so the amber "not callable" badge survived a commit
      // that just made the tool callable. `keys.tools` also covers `keys.tool(id)`, since
      // React Query invalidates by key prefix (verified against queryClient.ts's
      // `tool: (id) => ['tools', id]`).
      qc.invalidateQueries({ queryKey: keys.tools });
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
    onSuccess: () => {
      // Same readiness-badge fix as useCommitToolVersion above: the header badge and the
      // `/tools` row summary both read the tool resource, not the aliases list.
      qc.invalidateQueries({ queryKey: keys.tools });
    },
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
