import { z } from 'zod';
import { FeedbackFilterSchema } from '../../traces/feedback';

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
 * Cap on how many feedback rows one `from-feedback` request may draw from.
 * The build runs synchronously and each row costs several DB reads — resolving
 * its source span payload, and (since FAQ Q19) walking its session for prior
 * turns — so an unbounded list can hold a request open indefinitely. Build in
 * batches above this; the examples land in whichever dataset each batch names.
 */
export const MAX_FEEDBACK_IDS_PER_BUILD = 100;

/**
 * How a `from-feedback` request names the rows it wants: either an explicit list
 * of ids, or the criteria that select them.
 *
 * The `filter` form exists because hand-collecting ids does not scale past a
 * screenful. "Every thumbs-down on the checkout prompt since August, with a
 * written comment" is one object here and a morning of clicking otherwise.
 *
 * The message on the union is deliberately concrete: the common mistake is
 * sending both, and a bare "invalid body" would not say which half to drop.
 */
const feedbackSelectorFields = {
  feedback_ids: z.array(z.string().uuid()).min(1).max(MAX_FEEDBACK_IDS_PER_BUILD).optional(),
  filter: FeedbackFilterSchema.optional(),
};

/** Enforces exactly one of `feedback_ids` / `filter` on a from-feedback body. */
const exactlyOneSelector = (
  d: { feedback_ids?: string[]; filter?: unknown },
): boolean => (d.feedback_ids !== undefined) !== (d.filter !== undefined);

const SELECTOR_MESSAGE = 'Provide exactly one of feedback_ids or filter.';

/**
 * Payload for building a dataset from feedback rows.
 * Each feedback row becomes one example. The rows come from `feedback_ids` (at
 * most {@link MAX_FEEDBACK_IDS_PER_BUILD}) or from `filter`, never both.
 * `overall_feedback` applies to every example in the built dataset.
 */
export const BuildFromFeedbackSchema = z
  .object({
    name: z.string().min(1).max(200),
    overall_feedback: z.string().max(5000).optional(),
    ...feedbackSelectorFields,
  })
  .refine(exactlyOneSelector, { message: SELECTOR_MESSAGE });

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
 * Cap on how many prior `Trace`s a session-history reconstruction walks
 * back through (FAQ Q19). Bounds both the DB read and the tokens later
 * spent replaying it — conversations rarely need more than this many turns
 * of context for a judge/optimizer call to make sense of the flagged turn.
 */
export const MAX_HISTORY_TRACES = 20;

/**
 * Cap on a reconstructed `history`'s serialized size. Mirrors
 * `MAX_EXAMPLE_INPUT_BYTES`'s reasoning — history gets replayed into a live
 * LLM call on every run cell, so an unbounded value can blow past token
 * budgets. Oldest turns are dropped first (`capHistoryBytes`) rather than
 * rejecting the example outright.
 */
export const MAX_HISTORY_BYTES = 32768;

/**
 * Cap on how many messages a HAND-AUTHORED `history` may carry
 * (`AddExampleSchema`). A reconstruction has no equivalent message cap — it is
 * bounded by {@link MAX_HISTORY_TRACES} and {@link MAX_HISTORY_BYTES} instead,
 * because a real conversation's message count per turn is not something the
 * platform gets to choose. This one exists so a hand-written array can't
 * smuggle in hundreds of tiny messages under the byte ceiling.
 */
export const MAX_HISTORY_MESSAGES = 20;

/** Zod shape for one OpenAI-style chat message, used to validate a manually-authored `history`. */
const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().nullable(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({ name: z.string(), arguments: z.string() }),
      }),
    )
    .optional(),
  tool_call_id: z.string().optional(),
});

/**
 * Payload for adding one example to a dataset.
 * `input` is the raw prompt VARIABLES (from span_payloads.variables) — to be
 * re-rendered against any candidate template later.
 * `criteria` is the per-example rubric (source feedback comment).
 * `history` is an optional hand-authored prior-turn conversation (FAQ Q19),
 * the same shape a feedback-built example's reconstructed `history` carries.
 */
export const AddExampleSchema = z.object({
  input: z.record(z.unknown()).refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_EXAMPLE_INPUT_BYTES,
    { message: `input must serialize to at most ${MAX_EXAMPLE_INPUT_BYTES} bytes` },
  ),
  criteria: z.string().optional(),
  history: z
    .array(ChatMessageSchema)
    .max(MAX_HISTORY_MESSAGES)
    .refine(
      (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_HISTORY_BYTES,
      { message: `history must serialize to at most ${MAX_HISTORY_BYTES} bytes` },
    )
    .optional(),
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
  /** Prior-turn conversation reconstructed from the source session (FAQ Q19), or null if there was none. */
  history: import('../../gateway/providers/types').ChatMessage[] | null;
  sourceTraceId: string | null;
  sourceFeedbackId: string | null;
  sourcePromptVersionId: string | null;
  /**
   * The prompt version this example was captured from, resolved to readable
   * names so a client never has to render a bare UUID. Null for a manually
   * added row, and also null when the source version has since been deleted —
   * `sourcePromptVersionId` may be non-null while this is null.
   */
  sourcePrompt: SourcePromptInfo | null;
  createdAt: string;
}

/** Readable identity of the prompt version an example was captured from. */
export interface SourcePromptInfo {
  promptId: string;
  name: string;
  versionNumber: number;
  /**
   * The version's last user message, as committed. Raw template text, so it can
   * contain `{{ placeholders }}` — it is deliberately NOT rendered against the
   * example's `input`.
   *
   * It is version-level, not example-level: every example captured from this
   * version carries the same string. A client shows it only where there is no
   * per-example `input` to show instead, so that a row is never blank when the
   * prompt itself says what was asked. Null when the version has no user message
   * at all — the shape an app that appends the user's turn at request time
   * commits.
   */
  lastUserMessage: string | null;
}

/**
 * Payload for appending feedback rows to an existing dataset. Same selector and
 * same ceiling as {@link BuildFromFeedbackSchema} — the work per row is
 * identical, only the destination differs.
 */
export const AddExamplesFromFeedbackSchema = z
  .object(feedbackSelectorFields)
  .refine(exactlyOneSelector, { message: SELECTOR_MESSAGE });

/** Validated append-from-feedback payload. */
export type AddExamplesFromFeedbackDto = z.infer<typeof AddExamplesFromFeedbackSchema>;

/**
 * Payload for editing one example in place. `criteria` is `.nullable()` so the
 * caller can distinguish "not sent, leave unchanged" (key absent) from
 * "explicitly clear this rubric" (`null`) — the same shape
 * {@link UpdateDatasetSchema} uses.
 *
 * Only `criteria` is editable. `input` and `history` are the frozen record of
 * what actually ran (FAQ Q19); editing them would silently invalidate every
 * past run that graded against them.
 */
export const UpdateExampleSchema = z.object({
  criteria: z.string().min(1).max(5000, 'criteria must be 5000 characters or fewer.').nullable().optional(),
});

/** Validated example update payload. */
export type UpdateExampleDto = z.infer<typeof UpdateExampleSchema>;

/** One prompt whose examples don't match the run's target prompt, and how many. */
export interface MismatchedPromptInfo {
  promptId: string;
  name: string;
  exampleCount: number;
}

/**
 * Informational (never blocking) warning attached to an experiment/optimize
 * start response when the dataset's examples were sourced from a different
 * prompt than the one the run targets (design "Prompt-mismatch warning").
 */
export interface PromptMismatchWarning {
  mismatchedPrompts: MismatchedPromptInfo[];
}
