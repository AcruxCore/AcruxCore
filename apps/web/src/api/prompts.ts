import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Paginated, Prompt, PromptListItem } from './types';
import { api } from './client';
import { fetchAllPages } from './paging';
import { keys } from './queryClient';

/**
 * List prompts for the current team, one page at a time.
 *
 * Only for the prompts list page, which renders its own pagination UI around this —
 * every other caller that needs to resolve a prompt by id (a picker) wants
 * {@link useAllPrompts} instead, since a `<select>`/typeahead has no page-forward
 * control and would otherwise silently hide any prompt past the first `limit` rows.
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

/**
 * Every prompt the team owns, newest first.
 *
 * Reads all pages rather than the API's first-page default. The pickers that resolve a
 * prompt by id (Playground, the Save-version dialog, the evaluation dialogs, the traces
 * filter bar, …) render every option a `<select>`/typeahead offers from whatever list
 * they're given — unlike the prompts list page, they have no page-forward control, so a
 * paginated list here would quietly make any prompt past the first page unselectable and,
 * for a filter chip that already names one, unresolvable to its name.
 *
 * Cached under its own key (`keys.allPrompts`), separate from {@link usePrompts}'s
 * per-search/page keys, so the two never collide in the cache or race each other's
 * loading state.
 *
 * Inherits {@link fetchAllPages}'s own page cap (2,000 rows): a team past that many
 * prompts gets a truncated list here, not every prompt. The API orders `/prompts`
 * newest-first, so a truncation drops the *oldest* prompts specifically — everything
 * built on this list (including {@link filterPrompts}) only searches what actually
 * loaded, unlike the old `usePrompts({ search })`, which asked the server to search
 * every prompt in the table regardless of how many there were. See {@link filterPrompts}.
 */
export function useAllPrompts() {
  return useQuery({
    queryKey: keys.allPrompts,
    queryFn: () =>
      fetchAllPages<PromptListItem>(
        (page, limit) => api<Paginated<PromptListItem>>('/prompts', { query: { page, limit } }),
        'GET /prompts',
      ),
  });
}

/**
 * Narrows a full prompt list to those matching a free-text query, the same way the
 * server's own `search` param does (case-insensitive, against name or description) — so
 * client-side filtering on {@link useAllPrompts}'s full list behaves identically to what
 * `usePrompts({ search })` used to return, just without truncating at the first page.
 *
 * That equivalence holds only up to {@link useAllPrompts}'s own page cap. Below it, this
 * searches the same rows the server's own `search` would have. Above it (a team past
 * 2,000 prompts), `prompts` is already missing its oldest rows before this ever runs, so
 * a query matching only one of them finds nothing here — where the old server-side
 * `search` would have. Do not assume unconditional equivalence with server-side search;
 * this is only ever as complete as the list it's given.
 *
 * @param prompts - The full list to filter (typically {@link useAllPrompts}'s data).
 * @param query - What the user typed; blank returns everything.
 * @returns The matching prompts, in the order given.
 */
export function filterPrompts(prompts: PromptListItem[], query: string): PromptListItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return prompts;
  return prompts.filter(
    (p) => p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q),
  );
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
