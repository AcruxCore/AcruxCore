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
