import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AliasDetail } from './types';
import { api } from './client';
import { keys } from './queryClient';

/** Delete a custom alias (production/staging are protected server-side). */
export function useDeleteAlias(promptId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (alias: string) =>
      api<void>(`/prompts/${promptId}/aliases/${alias}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.aliases(promptId) });
      qc.invalidateQueries({ queryKey: ['audit', promptId] });
    },
  });
}

/** List a prompt's aliases and the version number each points to. */
export function useAliases(promptId: string) {
  return useQuery({
    queryKey: keys.aliases(promptId),
    queryFn: () => api<AliasDetail[]>(`/prompts/${promptId}/aliases`),
    enabled: !!promptId,
  });
}

/**
 * Point an alias at a version (promote forward or roll back).
 *
 * The API body uses snake_case `version_number`.
 */
export function usePromoteAlias(promptId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { alias: string; versionNumber: number }) =>
      api<AliasDetail>(
        `/prompts/${promptId}/aliases/${input.alias}/promote`,
        { method: 'POST', body: { version_number: input.versionNumber } },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.aliases(promptId) });
      qc.invalidateQueries({ queryKey: ['audit', promptId] });
    },
  });
}
