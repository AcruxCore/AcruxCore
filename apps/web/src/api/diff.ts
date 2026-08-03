import { useQuery } from '@tanstack/react-query';
import type { DiffResponse } from './types';
import { api } from './client';
import { keys } from './queryClient';

/**
 * Fetch a unified diff between two version numbers of a prompt.
 *
 * @param promptId - Prompt id.
 * @param from - Source version number.
 * @param to - Target version number.
 */
export function useDiff(promptId: string, from: number | null, to: number | null) {
  return useQuery({
    queryKey: keys.diff(promptId, from ?? 0, to ?? 0),
    queryFn: () =>
      api<DiffResponse>(`/prompts/${promptId}/versions/diff`, {
        query: { from: from!, to: to! },
      }),
    enabled: !!promptId && !!from && !!to && from !== to,
  });
}
