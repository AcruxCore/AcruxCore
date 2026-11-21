import { ValidationError } from '../../shared/errors';
import { MAX_EXPERIMENT_GRID_SIZE } from './experiments.types';

/**
 * Refuses a run that would enqueue more than {@link MAX_EXPERIMENT_GRID_SIZE} cell jobs.
 *
 * Each cell job is one paid provider call, and every job of a run is built in memory and
 * added in one Flow. The count must be checked where the jobs are about to exist, not only
 * when an experiment is created: a dataset keeps growing through `/examples/bulk` after
 * that, a run adds a baseline cell per model, and optimize has no experiment-create step.
 *
 * @param runCount - Cell jobs the caller is about to enqueue (grid cells x examples, or
 *   the largest number an optimize run can reach). Must be a non-negative integer.
 * @param what - Names the thing being started, for the message ("experiment's grid",
 *   "run", "optimize run").
 * @throws {ValidationError} When `runCount` exceeds the ceiling; the message names both
 *   numbers and what to reduce.
 */
export function assertWithinGridCeiling(runCount: number, what: string): void {
  if (runCount <= MAX_EXPERIMENT_GRID_SIZE) return;
  throw new ValidationError(
    `This ${what} would enqueue ${runCount} runs, which exceeds the ${MAX_EXPERIMENT_GRID_SIZE}-run ceiling. Reduce the number of versions, models, or dataset examples.`,
  );
}
