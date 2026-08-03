import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Paginated, Prompt, PromptListItem } from './types';
import { api } from './client';
import { keys } from './queryClient';

/**
 * List prompts for the current team.
 *
 * @param params - Optional `search` term and `page` (1-based).
 */
export function usePrompts(params: { search?: string; page?: number } = {}) {
  const { search, page = 1 } = params;
  return useQuery({
    queryKey: keys.prompts(search, page),
    queryFn: () =>
      api<Paginated<PromptListItem>>('/prompts', {
        query: { search, page, limit: 20 },
      }),
  });
}

/** Fetch a single prompt by id. */
export function usePrompt(id: string) {
  return useQuery({
    queryKey: keys.prompt(id),
    queryFn: () => api<Prompt>(`/prompts/${id}`),
    enabled: !!id,
  });
}

/** Create a prompt shell (name + optional description). */
export function useCreatePrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; description?: string }) =>
      api<Prompt>('/prompts', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['prompts'] }),
  });
}

/** Rename a prompt or edit its description. */
export function useUpdatePrompt(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; description?: string | null }) =>
      api<Prompt>(`/prompts/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.prompt(id) });
      qc.invalidateQueries({ queryKey: ['prompts'] });
    },
  });
}

/** Soft-delete a prompt. */
export function useDeletePrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/prompts/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['prompts'] }),
  });
}
