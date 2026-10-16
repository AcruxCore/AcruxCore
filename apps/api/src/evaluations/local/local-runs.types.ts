import { z } from 'zod';

/** The `model` label a local run's cell gets when the caller names none. */
export const DEFAULT_LOCAL_MODEL_LABEL = 'local';

/** The grid `variantKind` that marks a local run (phase-5 FAQ Q46). */
export const LOCAL_VARIANT_KIND = 'local';

/** Cap on results per `POST /runs/:id/results` call; the SDKs send 20 at a time. */
export const MAX_LOCAL_RESULTS_PER_BATCH = 100;

/** Cap on named scores per result. A scorer list longer than this is a bug, not a test. */
export const MAX_SCORES_PER_RESULT = 50;

/**
 * Cap on one result's serialized `output`. An app's output is shown in the
 * drill-down and the compare view, so it has to stay readable, and the API's
 * 1 MB body limit has to fit a whole batch.
 */
export const MAX_LOCAL_OUTPUT_BYTES = 64 * 1024;

/**
 * Payload for `POST /experiments/local`. `name` labels the run's one cell and
 * becomes the experiment name. `model` is free text: the app under test may call
 * several models, or none through the gateway, so it is never checked against
 * Gateway → Models. `primary_score` names the score copied into each result's
 * `score`/`passed`/`reason`; omitted, the first score of each result is used.
 */
export const CreateLocalExperimentSchema = z.object({
  dataset_id: z.string().uuid(),
  name: z
    .string({ required_error: 'name is required: it labels this run, e.g. "v2".' })
    .trim()
    .min(1, 'name must not be empty.')
    .max(100)
    .refine((v) => !v.includes('|'), { message: 'name must not contain "|".' }),
  model: z.string().trim().min(1).max(200).optional(),
  primary_score: z.string().trim().min(1).max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
});

/** Validated create-local-experiment payload. */
export type CreateLocalExperimentDto = z.infer<typeof CreateLocalExperimentSchema>;

/** One named score a scorer produced, on the wire. Scores are 0–100, like the judge's. */
export const LocalScoreSchema = z.object({
  name: z.string().trim().min(1).max(100),
  score: z.number().min(0).max(100).nullable(),
  passed: z.boolean().nullable().optional(),
  reason: z.string().max(5000).nullable().optional(),
});

/** One example's result, on the wire. */
export const LocalResultSchema = z.object({
  example_id: z.string().uuid(),
  output: z
    .unknown()
    .refine(
      (value) => value === undefined || Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_LOCAL_OUTPUT_BYTES,
      { message: `output must serialize to at most ${MAX_LOCAL_OUTPUT_BYTES} bytes` },
    ),
  trace_id: z.string().uuid().nullable().optional(),
  error: z.string().max(5000).nullable().optional(),
  scores: z
    .array(LocalScoreSchema)
    .max(MAX_SCORES_PER_RESULT)
    .refine((list) => new Set(list.map((s) => s.name)).size === list.length, {
      message: 'score names must be unique within one result.',
    })
    .default([]),
});

/** Payload for `POST /runs/:id/results`. */
export const SubmitLocalResultsSchema = z.object({
  results: z
    .array(LocalResultSchema)
    .min(1, 'results must hold at least one result.')
    .max(MAX_LOCAL_RESULTS_PER_BATCH, `results may hold at most ${MAX_LOCAL_RESULTS_PER_BATCH} per call.`),
});

/** Validated results batch. */
export type SubmitLocalResultsDto = z.infer<typeof SubmitLocalResultsSchema>;

/** Payload for `POST /runs/:id/finish`. An `error` marks the run failed. */
export const FinishLocalRunSchema = z.object({
  error: z.string().min(1).max(5000).optional(),
});

/** Validated finish payload. */
export type FinishLocalRunDto = z.infer<typeof FinishLocalRunSchema>;

/**
 * A stored named score: the wire shape with `passed` and `reason` always
 * present. `passed` is filled from the score (`>= 50`) when the scorer gave none.
 */
export interface StoredLocalScore {
  name: string;
  score: number | null;
  passed: boolean | null;
  reason: string | null;
}

/** `experiments.config` of a local experiment. It has no judge and no prompt grid. */
export interface LocalExperimentConfig {
  kind: 'local';
  model: string;
  primaryScore?: string;
  metadata?: Record<string, unknown>;
}

/** One frozen example as the SDK needs it to run the task and the scorers. */
export interface LocalRunExampleDto {
  id: string;
  input: Record<string, unknown>;
  criteria: string | null;
  expected: unknown;
  /** Prior turns of an example built from a session (FAQ Q19), or null. */
  history: unknown[] | null;
}

/** Response of `POST /experiments/local` (snake_case, like `POST /experiments/:id/runs`). */
export interface CreateLocalExperimentResponse {
  experiment_id: string;
  run_id: string;
  cell_key: string;
  /** The run's page in the dashboard, or null when the server has no `APP_URL`. */
  url: string | null;
  examples: LocalRunExampleDto[];
}

/** Response of `POST /runs/:id/results`. */
export interface SubmitLocalResultsResponse {
  /** Results written by this call. */
  written: number;
  /** Examples in the run that have a result so far. */
  completed: number;
  /** Examples frozen into the run. */
  total: number;
}
