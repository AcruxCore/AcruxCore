import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { ApiQuery } from './client';
import { keys } from './queryClient';
import type {
  AddExamplesFromFeedbackInput,
  AddExamplesFromFeedbackResult,
  AddDatasetExampleInput,
  CandidateDetail,
  CreateDatasetFromFeedbackInput,
  CreateDatasetFromFeedbackResult,
  CreateDatasetInput,
  CreateExperimentInput,
  Dataset,
  DatasetDetail,
  DatasetExample,
  DatasetListResponse,
  Experiment,
  ExperimentListResponse,
  OptimizeInput,
  Paginated,
  PromoteCandidateInput,
  PromoteCandidateResult,
  Run,
  RunCellDetail,
  RunListFilters,
  RunListItem,
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
 * Adds one hand-authored example to a dataset — the route into evaluation for
 * a team that has no feedback to build from yet. Invalidates the detail query
 * (the examples table) and the list (its example count).
 *
 * @param id - Dataset UUID the example is added to.
 */
export function useAddDatasetExample(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddDatasetExampleInput) =>
      api<DatasetExample>(`/datasets/${id}/examples`, { method: 'POST', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.datasets });
      qc.invalidateQueries({ queryKey: keys.dataset(id) });
    },
  });
}

/**
 * Appends feedback rows to a dataset that already exists — the second and every
 * later pass over the feedback list, where {@link useCreateDatasetFromFeedback}
 * only covers the first.
 *
 * The result's `added` can be 0 with no error: every selected row was already in
 * the dataset, or none was eligible. `skipped[]` says which and why, so the
 * caller reports that rather than a bare success.
 *
 * @param id - Dataset UUID to append to.
 */
export function useAddExamplesFromFeedback(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddExamplesFromFeedbackInput) =>
      api<AddExamplesFromFeedbackResult>(`/datasets/${id}/examples/from-feedback`, { method: 'POST', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.datasets });
      qc.invalidateQueries({ queryKey: keys.dataset(id) });
    },
  });
}

/**
 * Edits one example's criteria — the per-example rubric the judge grades
 * against. A row built from feedback inherits the raw complaint, which grades
 * badly reused verbatim, so rewording it is ordinary curation.
 *
 * Send `criteria: null` to clear the rubric; omitting the key leaves it alone.
 *
 * @param id - Dataset UUID the example belongs to.
 */
export function useUpdateDatasetExample(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ exampleId, criteria }: { exampleId: string; criteria: string | null }) =>
      api<DatasetExample>(`/datasets/${id}/examples/${exampleId}`, { method: 'PATCH', body: { criteria } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.dataset(id) }),
  });
}

/**
 * Removes one example from a dataset. Invalidates the detail query (the table)
 * and the list (its example count).
 *
 * Past runs that graded this example keep their results — the run's frozen
 * `exampleSnapshot` is what they read, not this row.
 *
 * @param id - Dataset UUID the example belongs to.
 */
export function useRemoveDatasetExample(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (exampleId: string) =>
      api<{ success: true }>(`/datasets/${id}/examples/${exampleId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.datasets });
      qc.invalidateQueries({ queryKey: keys.dataset(id) });
    },
  });
}

/**
 * Deletes one evaluation/optimize run and its cells. The parent experiment and
 * any optimizer candidates the run drafted survive. Invalidates every `runs`
 * list query (the filters are part of the key, so an exact match is not enough)
 * plus this run's own detail/report queries.
 *
 * Rejects with a 409 `RUN_IN_FLIGHT` while the run is still queued or running.
 */
export function useDeleteRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ success: true }>(`/runs/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['runs'] });
      qc.invalidateQueries({ queryKey: keys.run(id) });
      qc.invalidateQueries({ queryKey: keys.runReport(id) });
    },
  });
}

/**
 * Soft-deletes a dataset. Invalidates `keys.datasets` so the list drops it, and
 * deliberately does **not** touch `keys.dataset(id)`.
 *
 * Both of the obvious things do the wrong thing here, because the delete is
 * normally fired from the detail page, where that query still has a mounted
 * observer. `invalidateQueries` refetches it; `removeQueries` drops the entry
 * and the live observer immediately refetches to replace it. Either way
 * `GET /datasets/:id` runs against an id that no longer resolves and logs a 404,
 * which reads as a bug to anyone with devtools open.
 *
 * Leaving it alone is correct rather than merely quiet: the caller navigates
 * away, the observer unmounts, and the stale entry is garbage-collected without
 * anyone asking the server about a row that is gone.
 *
 * @param id - Dataset UUID to delete.
 */
export function useDeleteDataset(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ success: true }>(`/datasets/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.datasets }),
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
 * Lists the team's runs newest-first for the run-history screen, with each
 * run's dataset, grid shape and scores.
 *
 * Polls at {@link RUN_POLL_INTERVAL_MS} while **any** row on the page is still
 * `queued`/`running`, and stops once every row has settled — a run started in
 * another tab (or by a teammate) fills in without a manual refresh, and a page
 * of finished runs costs nothing.
 *
 * @param filters - Wire-shaped (`snake_case`) status/dataset/prompt filters and
 *   pagination. Empty values are dropped by the client's query serializer.
 */
export function useRuns(filters: RunListFilters) {
  const query = filters as ApiQuery;
  return useQuery({
    queryKey: keys.runs(query),
    queryFn: () => api<Paginated<RunListItem>>('/runs', { query }),
    refetchInterval: (q) =>
      (q.state.data?.data ?? []).some((run) => run.status === 'queued' || run.status === 'running')
        ? RUN_POLL_INTERVAL_MS
        : false,
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
