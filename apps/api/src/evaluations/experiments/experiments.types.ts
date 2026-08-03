import { z } from 'zod';

/** Per-dimension cap on `version_ids`/`models` — a fan-out safety net, see `MAX_EXPERIMENT_GRID_SIZE`. */
export const MAX_EXPERIMENT_DIMENSION = 50;

/**
 * Ceiling on `version_ids.length * models.length * datasetExampleCount` — the
 * total number of paid provider calls one experiment run would enqueue.
 * Enforced in `experiments.service.ts::create()` (needs the dataset's example
 * count, not available at schema-parse time). Conservative and tunable later;
 * the point is that *some* ceiling exists.
 */
export const MAX_EXPERIMENT_GRID_SIZE = 2000;

/**
 * Payload for creating an experiment: a dataset to evaluate against, an
 * optional prompt under test, and the (prompt-version × model) grid to sweep.
 * `version_ids` and `models` must each have at least one entry — an
 * experiment with an empty grid has nothing to run — and at most
 * `MAX_EXPERIMENT_DIMENSION`, a per-dimension cost/DoS cap independent of the
 * combined-grid-size check applied later against the dataset's example count.
 */
export const CreateExperimentSchema = z.object({
  dataset_id: z.string().uuid(),
  prompt_id: z.string().uuid().optional(),
  name: z.string().min(1).max(200).optional(),
  version_ids: z.array(z.string().uuid()).min(1).max(MAX_EXPERIMENT_DIMENSION),
  models: z.array(z.string().min(1)).min(1).max(MAX_EXPERIMENT_DIMENSION),
});

/** Validated create-experiment payload. */
export type CreateExperimentDto = z.infer<typeof CreateExperimentSchema>;

/** Resolved (prompt-variant × model) sweep persisted on `experiments.config`. */
export interface ExperimentConfig {
  versionIds: string[];
  models: string[];
}

/** Response DTO for an experiment run (summary — no results list). */
export interface ExperimentRunDto {
  id: string;
  experimentId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  createdAt: string;
}

/**
 * Response DTO for an experiment. `runs` is populated on `getById` (newest
 * first) and omitted (empty array) on `list`/`create`.
 */
export interface ExperimentDto {
  id: string;
  teamId: string;
  datasetId: string;
  promptId: string | null;
  name: string | null;
  config: ExperimentConfig;
  createdBy: string | null;
  createdAt: string;
  runs: ExperimentRunDto[];
}
