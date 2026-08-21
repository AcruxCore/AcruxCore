import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiQuery } from './client';
import { keys } from './queryClient';
import type {
  CreateEvalRuleInput,
  EvalRule,
  EvalRulePreviewVerdict,
  EvalRuleScore,
  EvalRuleScoreFilters,
  Paginated,
  ToDatasetInput,
  ToDatasetResult,
} from './types';

/** Lists the team's online-eval rules, each with today's match count and mean score. */
export function useEvalRules() {
  return useQuery({
    queryKey: keys.evalRules,
    queryFn: () => api<EvalRule[]>('/eval-rules'),
  });
}

/**
 * Creates an online-eval rule. Invalidates `keys.evalRules` so the list
 * picks it up.
 */
export function useCreateEvalRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEvalRuleInput) => api<EvalRule>('/eval-rules', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.evalRules }),
  });
}

/**
 * Updates a rule's criteria, sampling, limits, or filter. Invalidates both
 * the list and this rule's own detail query.
 *
 * @param id - Rule UUID being edited.
 */
export function useUpdateEvalRule(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<CreateEvalRuleInput>) =>
      api<EvalRule>(`/eval-rules/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.evalRules });
      qc.invalidateQueries({ queryKey: keys.evalRule(id) });
    },
  });
}

/**
 * Deletes an online-eval rule. Invalidates `keys.evalRules` so the list
 * drops it.
 */
export function useDeleteEvalRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ success: boolean }>(`/eval-rules/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.evalRules }),
  });
}

/**
 * Lists a rule's persisted judge verdicts, newest first, for the rule's
 * scores drawer/table.
 *
 * @param id - Rule UUID.
 * @param filters - Page/limit and optional min/max score bounds.
 */
export function useEvalRuleScores(id: string, filters: EvalRuleScoreFilters) {
  const query = filters as ApiQuery;
  return useQuery({
    queryKey: keys.evalRuleScores(id, query),
    queryFn: () => api<Paginated<EvalRuleScore>>(`/eval-rules/${id}/scores`, { query }),
  });
}

/**
 * Dry-runs a rule against its most recent matching spans without persisting
 * anything — lets the editor show sample verdicts before the rule goes live.
 *
 * @param id - Rule UUID being previewed.
 */
export function usePreviewEvalRule(id: string) {
  return useMutation({
    mutationFn: (limit: number) =>
      api<EvalRulePreviewVerdict[]>(`/eval-rules/${id}/preview`, { method: 'POST', body: { limit } }),
  });
}

/**
 * Builds a dataset from this rule's persisted verdicts scoring below
 * `threshold` — the "send low scorers to a dataset" flow. Creates a real
 * dataset row, so a successful call invalidates the datasets list.
 *
 * @param id - Rule UUID whose scores are being mined.
 */
export function useToDataset(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ToDatasetInput) => api<ToDatasetResult>(`/eval-rules/${id}/to-dataset`, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.datasets }),
  });
}
