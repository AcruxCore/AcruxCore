import type { CreateDatasetFromFeedbackInput } from '@/api/types';

/** A dataset made by one "Improve from feedback" attempt, and the request that made it. */
export interface AttemptDataset {
  id: string;
  /** The create request, serialized, so a retry can tell whether it asks for the same dataset. */
  requestKey: string;
}

/**
 * Returns the dataset for this "Improve from feedback" attempt, creating it only
 * when no earlier attempt made the same one.
 *
 * The dialog creates the dataset, then starts the optimize run. When the run is
 * refused (a judge prompt with no version, a model removed), the dataset stays.
 * Dataset names are not unique, so without this each retry adds another copy
 * holding the same examples (issue #692). A retry that changed the name, the
 * overall feedback or the rows asks for a different dataset and gets a new one.
 *
 * @param previous - The dataset an earlier attempt in this dialog made, or null.
 * @param body - The create request for this attempt.
 * @param create - Creates the dataset; called at most once per distinct request.
 * @returns The dataset to optimize against, with the key to pass back next time.
 */
export async function datasetForAttempt(
  previous: AttemptDataset | null,
  body: CreateDatasetFromFeedbackInput,
  create: (body: CreateDatasetFromFeedbackInput) => Promise<{ id: string }>,
): Promise<AttemptDataset> {
  const requestKey = JSON.stringify([body.name, body.overall_feedback ?? null, body.feedback_ids ?? null, body.filter ?? null]);
  if (previous && previous.requestKey === requestKey) return previous;
  const dataset = await create(body);
  return { id: dataset.id, requestKey };
}
