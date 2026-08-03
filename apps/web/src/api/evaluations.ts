import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { keys } from './queryClient';
import type {
  CandidateDetail,
  CreateDatasetFromFeedbackInput,
  CreateDatasetFromFeedbackResult,
  CreateDatasetInput,
  CreateExperimentInput,
  Dataset,
  DatasetDetail,
  DatasetListResponse,
  Experiment,
  ExperimentListResponse,
  OptimizeInput,
  PromoteCandidateInput,
  PromoteCandidateResult,
  Run,
  RunCellDetail,
  RunReport,
  RunStatus,
  StartRunResponse,
  UpdateDatasetInput,
} from './types';

/**
 * A run/report is still in flight while its status is `queued` or `running`
 * — TanStack Query polls at this cadence until it settles into `succeeded`/
 * `failed`, then stops.
 */
const RUN_POLL_INTERVAL_MS = 1500;

/**
 * Shared `refetchInterval` predicate for {@link useRun} and
 * {@link useRunReport}: keep polling while the run hasn't settled yet.
 *
 * @param status - The run's current status, or `undefined` before the first fetch resolves.
 * @returns The poll interval in ms, or `false` to stop polling.
 */
export function pollWhileInFlight(status: RunStatus | undefined): number | false {
  return status === 'queued' || status === 'running' ? RUN_POLL_INTERVAL_MS : false;
}

/**
 * Lists the team's non-deleted datasets, newest activity first. No
 * pagination params — the endpoint returns the full team list in `data`.
 */
export function useDatasets() {
  return useQuery({
    queryKey: keys.datasets,
    queryFn: () => api<DatasetListResponse>('/datasets'),
  });
}

/**
 * Fetches one dataset with its full example list. Disabled until an id is
 * present.
 *
 * @param id - Dataset UUID, or null while the route param is unresolved.
 */
export function useDataset(id: string | null) {
  return useQuery({
    queryKey: keys.dataset(id ?? ''),
    queryFn: () => api<DatasetDetail>(`/datasets/${id}`),
    enabled: !!id,
  });
}

/**
 * Creates an empty dataset (no examples yet). Invalidates `keys.datasets` so
 * the list picks it up.
 */
export function useCreateDataset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDatasetInput) => api<Dataset>('/datasets', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.datasets }),
  });
}

/**
 * Updates a dataset's name and/or overall feedback. Invalidates both the
 * list and the detail query for this dataset.
 *
 * @param id - Dataset UUID being edited.
 */
export function useUpdateDataset(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateDatasetInput) => api<Dataset>(`/datasets/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.datasets });
      qc.invalidateQueries({ queryKey: keys.dataset(id) });
    },
  });
}

/**
 * Builds a dataset from selected feedback rows in one call (the row-selection
 * → "Create dataset" flow). Invalidates `keys.datasets` on success; the
 * result's `skipped[]` reports any feedback rows that were ineligible
 * (no captured variables).
 */
export function useCreateDatasetFromFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDatasetFromFeedbackInput) =>
      api<CreateDatasetFromFeedbackResult>('/datasets/from-feedback', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.datasets }),
  });
}

/**
 * Soft-deletes a dataset. Invalidates `keys.datasets` so the list drops it;
 * a subsequent `GET /datasets/:id` for this id 404s just like a nonexistent
 * one, so the detail query is invalidated too (it will error if still mounted).
 *
 * @param id - Dataset UUID to delete.
 */
export function useDeleteDataset(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ success: true }>(`/datasets/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.datasets });
      qc.invalidateQueries({ queryKey: keys.dataset(id) });
    },
  });
}

/**
 * Lists the team's experiments, with their runs (newest first) populated on
 * every entry.
 */
export function useExperiments() {
  return useQuery({
    queryKey: keys.experiments,
    queryFn: () => api<ExperimentListResponse>('/experiments'),
  });
}

/**
 * Fetches one experiment with its runs. Disabled until an id is present.
 *
 * @param id - Experiment UUID, or null while the route param is unresolved.
 */
export function useExperiment(id: string | null) {
  return useQuery({
    queryKey: keys.experiment(id ?? ''),
    queryFn: () => api<Experiment>(`/experiments/${id}`),
    enabled: !!id,
  });
}

/**
 * Creates an experiment: a dataset to evaluate, an optional prompt under
 * test, and the (prompt-version × model) grid to sweep. Invalidates
 * `keys.experiments` so the list picks it up.
 */
export function useCreateExperiment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateExperimentInput) => api<Experiment>('/experiments', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.experiments }),
  });
}

/**
 * Starts a run for an experiment: freezes the dataset's examples, resolves
 * the grid, and enqueues the BullMQ flow. Returns immediately with
 * `{ run_id, status: 'queued' }` — the caller should switch to polling
 * {@link useRun}/{@link useRunReport} with the returned id. Invalidates the
 * experiment (its `runs[]` now includes the new one) and the experiments list.
 */
export function useStartRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (experimentId: string) =>
      api<StartRunResponse>(`/experiments/${experimentId}/runs`, { method: 'POST' }),
    onSuccess: (_data, experimentId) => {
      qc.invalidateQueries({ queryKey: keys.experiment(experimentId) });
      qc.invalidateQueries({ queryKey: keys.experiments });
    },
  });
}

/**
 * Fetches a run's status, grid, and result counts. Polls every
 * {@link RUN_POLL_INTERVAL_MS} while the run is `queued`/`running`, and stops
 * once it settles into `succeeded`/`failed`. Disabled until an id is present.
 *
 * @param id - Run UUID, or null while unresolved.
 */
export function useRun(id: string | null) {
  return useQuery({
    queryKey: keys.run(id ?? ''),
    queryFn: () => api<Run>(`/runs/${id}`),
    enabled: !!id,
    refetchInterval: (query) => pollWhileInFlight(query.state.data?.status),
  });
}

/**
 * Fetches the comparison report (the full variant × model matrix with
 * per-cell averages, regression deltas, leaderboard, and advisory winner).
 * This is the query the leaderboard UI watches, so it polls the same way
 * {@link useRun} does — every {@link RUN_POLL_INTERVAL_MS} while in flight,
 * stopping once the run settles. Disabled until an id is present.
 *
 * @param id - Run UUID, or null while unresolved.
 */
export function useRunReport(id: string | null) {
  return useQuery({
    queryKey: keys.runReport(id ?? ''),
    queryFn: () => api<RunReport>(`/runs/${id}/report`),
    enabled: !!id,
    refetchInterval: (query) => pollWhileInFlight(query.state.data?.status),
  });
}

/**
 * On-demand drill-down for one grid cell: its per-example outputs, judge
 * reasoning, and trace links. Disabled until both a run id and a cell key
 * are present (the click-a-cell interaction populates `cellKey` lazily).
 *
 * @param id - Run UUID, or null while unresolved.
 * @param cellKey - The cell's `${variantLabel}|${model}` key (not yet
 *   URL-encoded — this hook encodes it), or null before a cell is selected.
 */
export function useRunCell(id: string | null, cellKey: string | null) {
  return useQuery({
    queryKey: keys.runCell(id ?? '', cellKey ?? ''),
    queryFn: () => api<RunCellDetail>(`/runs/${id}/cells/${encodeURIComponent(cellKey ?? '')}`),
    enabled: !!id && !!cellKey,
  });
}

/**
 * Kicks off an optimize attempt for a prompt: drafts candidate rewrites
 * against a dataset, then runs them (plus the production baseline) through
 * the same grid/report machinery as a regular experiment. Returns
 * immediately with `{ run_id, status: 'queued' }` — poll {@link useRun}/
 * {@link useRunReport} with the returned id the same way as a regular run.
 *
 * @param promptId - The prompt whose `production` version is being improved.
 */
export function useOptimize(promptId: string) {
  return useMutation({
    mutationFn: (body: OptimizeInput) => api<StartRunResponse>(`/prompts/${promptId}/optimize`, { method: 'POST', body }),
  });
}

/**
 * Promotes one optimizer-drafted candidate to a real, immutable prompt
 * version and moves an alias (default `production`) onto it. Invalidates
 * the run and its report so the UI reflects the promoted state.
 *
 * @param runId - The run the candidate belongs to.
 */
export function usePromoteCandidate(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PromoteCandidateInput) =>
      api<PromoteCandidateResult>(`/runs/${runId}/promote`, { method: 'POST', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.run(runId) });
      qc.invalidateQueries({ queryKey: keys.runReport(runId) });
    },
  });
}

/**
 * Fetches one optimizer-drafted candidate's own template + rationale (E7
 * Task 5) — the read the promote-review dialog needs to show WHAT is about
 * to become a real version before a human confirms {@link usePromoteCandidate}.
 * Disabled until both a run id and a candidate id are present.
 *
 * @param runId - Run UUID, or null while unresolved.
 * @param candidateId - `prompt_candidates` row UUID, or null before a candidate cell is selected.
 */
export function useRunCandidate(runId: string | null, candidateId: string | null) {
  return useQuery({
    queryKey: keys.runCandidate(runId ?? '', candidateId ?? ''),
    queryFn: () => api<CandidateDetail>(`/runs/${runId}/candidates/${candidateId}`),
    enabled: !!runId && !!candidateId,
  });
}
