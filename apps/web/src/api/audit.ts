import { useQuery } from '@tanstack/react-query';
import type { AuditEntry, Paginated } from './types';
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
