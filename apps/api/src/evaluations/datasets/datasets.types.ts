import { z } from 'zod';

/**
 * Payload for creating an empty dataset.
 * `name` is required; `overall_feedback` is an optional dataset-level directive
 * applied to every example by the judge.
 */
export const CreateDatasetSchema = z.object({
  name: z.string().min(1).max(200),
  overall_feedback: z.string().max(5000).optional(),
});

/** Validated create dataset payload. */
export type CreateDatasetDto = z.infer<typeof CreateDatasetSchema>;

/**
 * Payload for building a dataset from feedback rows.
 * Each feedback row becomes one example; `feedback_ids` must have at least one.
 * `overall_feedback` applies to every example in the built dataset.
 */
export const BuildFromFeedbackSchema = z.object({
  name: z.string().min(1).max(200),
  overall_feedback: z.string().max(5000).optional(),
  feedback_ids: z.array(z.string().uuid()).min(1),
});

/** Validated build-from-feedback payload. */
export type BuildFromFeedbackDto = z.infer<typeof BuildFromFeedbackSchema>;

/**
 * Payload for updating an existing dataset.
 * All fields are optional; `overall_feedback` is nullable so the caller can
 * explicitly clear it (distinguish "not sent" from "clear this field").
 */
export const UpdateDatasetSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  overall_feedback: z.string().max(5000).nullable().optional(),
});

/** Validated update dataset payload. */
export type UpdateDatasetDto = z.infer<typeof UpdateDatasetSchema>;

/**
 * Ceiling on a manually-added example's `input` serialized size (Finding #24).
 * `input` later gets rendered into a live LLM prompt via nunjucks during eval
 * runs, so an unbounded value can blow past token budgets on every run built
 * from it. 8 KB is generous for prompt variables — a few paragraphs of text.
 */
export const MAX_EXAMPLE_INPUT_BYTES = 8192;

/**
 * Payload for adding one example to a dataset.
 * `input` is the raw prompt VARIABLES (from span_payloads.variables) — to be
 * re-rendered against any candidate template later.
 * `criteria` is the per-example rubric (source feedback comment).
 */
export const AddExampleSchema = z.object({
  input: z.record(z.unknown()).refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_EXAMPLE_INPUT_BYTES,
    { message: `input must serialize to at most ${MAX_EXAMPLE_INPUT_BYTES} bytes` },
  ),
  criteria: z.string().optional(),
});

/** Validated add-example payload. */
export type AddExampleDto = z.infer<typeof AddExampleSchema>;

/**
 * Response DTO for a dataset. Includes the example count but not the full list
 * (callers fetch examples separately via getDatasetById or a list-examples endpoint).
 */
export interface DatasetDto {
  id: string;
  teamId: string;
  name: string;
  overallFeedback: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  exampleCount: number;
}

/**
 * Response DTO for a dataset example. Includes lineage info
 * (source trace/feedback/prompt version) for traceability.
 */
export interface DatasetExampleDto {
  id: string;
  datasetId: string;
  input: Record<string, unknown>;
  criteria: string | null;
  sourceTraceId: string | null;
  sourceFeedbackId: string | null;
  sourcePromptVersionId: string | null;
  createdAt: string;
}
