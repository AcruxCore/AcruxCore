import { useQuery } from '@tanstack/react-query';
import type { DiffResponse } from './types';
import { api, ApiError } from './client';
import { keys } from './queryClient';

/**
 * Fetch a unified diff between two version numbers of a prompt.
 *
 * @param promptId - Prompt id.
 * @param from - Source version number.
 * @param to - Target version number.
 * @returns The query; its error is an `ApiError` with code `DIFF_TOO_LARGE` when the
 *   versions differ in too many lines for the server to diff.
 */
export function useDiff(promptId: string, from: number | null, to: number | null) {
  return useQuery({
    queryKey: keys.diff(promptId, from ?? 0, to ?? 0),
    queryFn: () =>
      api<DiffResponse>(`/prompts/${promptId}/versions/diff`, {
        query: { from: from!, to: to! },
      }),
    enabled: !!promptId && !!from && !!to && from !== to,
    // DIFF_TOO_LARGE (422) is the server's settled answer for this pair; asking again
    // only spends another bounded-but-blocking diff on the API.
    retry: (count, error) =>
      !(error instanceof ApiError && [401, 403, 404, 422].includes(error.status)) && count < 1,
  });
}
