/**
 * A single ineligible feedback row reported back by `POST /datasets/from-feedback`.
 * Mirrors {@link import('@/api').CreateDatasetFromFeedbackResult}'s `skipped[]` shape.
 */
export interface SkippedFeedback {
  feedbackId: string;
  reason: string;
}

/**
 * Formats the one-line summary shown after a dataset-from-feedback create call.
 *
 * @param count - `example_count` from the response — how many examples were added.
 * @param skipped - The `skipped[]` array from the response.
 * @returns `"N added."` when nothing was skipped, otherwise `"N added, M skipped."`.
 */
export function formatSkipped(count: number, skipped: SkippedFeedback[]): string {
  if (skipped.length === 0) {
    return `${count} added.`;
  }
  return `${count} added, ${skipped.length} skipped.`;
}
