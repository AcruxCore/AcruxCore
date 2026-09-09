import { useQuery } from '@tanstack/react-query';
import type { AuditActor, AuditEntry, Paginated, TeamAuditFilters } from './types';
import { api } from './client';
import { keys } from './queryClient';

/** Fetch a page of the prompt's audit trail. */
export function useAudit(promptId: string, page: number) {
  return useQuery({
    queryKey: keys.audit(promptId, page),
    queryFn: () =>
      api<Paginated<AuditEntry>>(`/prompts/${promptId}/audit`, {
        query: { page, limit: 20 },
      }),
    enabled: !!promptId,
  });
}

/** Fetch a page of the tool's audit trail — its own version commits, alias
 * promotions, and code-sync supersedes. */
export function useToolAudit(toolId: string, page: number) {
  return useQuery({
    queryKey: keys.toolAudit(toolId, page),
    queryFn: () =>
      api<Paginated<AuditEntry>>(`/tools/${toolId}/audit`, {
        query: { page, limit: 20 },
      }),
    enabled: !!toolId,
  });
}

/** Rows per page on the team-wide audit screen. */
const TEAM_AUDIT_PAGE_SIZE = 25;

/**
 * Fetch a page of the whole team's audit trail — every event, not just those
 * tied to one prompt or tool.
 *
 * Filtering is server-side on purpose: the trail runs to thousands of rows, so
 * narrowing a single 25-row page in the browser would hide matches sitting on
 * every other page and report a wrong total.
 *
 * @param teamId - The team whose trail to read; the endpoint is owner/admin only.
 * @param page - 1-indexed page number.
 * @param filters - Optional event-name list and actor id, AND-ed by the API.
 * @returns The query result; `total` counts the filtered set.
 */
export function useTeamAudit(teamId: string, page: number, filters: TeamAuditFilters = {}) {
  const events = filters.events ?? [];
  const actorId = filters.actorId ?? '';
  return useQuery({
    queryKey: keys.teamAudit(teamId, page, events, actorId),
    queryFn: () =>
      api<Paginated<AuditEntry>>(`/teams/${teamId}/audit`, {
        query: {
          page,
          limit: TEAM_AUDIT_PAGE_SIZE,
          // The API takes one comma-separated list, not a repeated param.
          ...(events.length > 0 ? { event: events.join(',') } : {}),
          ...(actorId ? { actorId } : {}),
        },
      }),
    enabled: !!teamId,
  });
}

/**
 * Fetch the option list for the audit screen's actor filter: everyone who has
 * written an event for this team, including members who have since been removed.
 *
 * @param teamId - The team whose trail to read; owner/admin only.
 * @returns The query result, ascending by email.
 */
export function useTeamAuditActors(teamId: string) {
  return useQuery({
    queryKey: keys.teamAuditActors(teamId),
    queryFn: () => api<{ data: AuditActor[] }>(`/teams/${teamId}/audit/actors`),
    enabled: !!teamId,
  });
}

export { TEAM_AUDIT_PAGE_SIZE };
