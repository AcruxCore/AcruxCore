import { getJudgeQueue } from './queues';

/**
 * The BullMQ job id of a result's judge job. `cell.processor` enqueues each judge job
 * under this id, so finalize can ask for one job's state instead of reading the queue.
 * BullMQ refuses `:` in a custom id, so the separator is `-`.
 *
 * @param resultId - The `eval_result` the job grades.
 * @returns `judge-<resultId>`.
 */
export function judgeJobId(resultId: string): string {
  return `judge-${resultId}`;
}

/**
 * Every state in which a judge job will still run again: queued, running, or waiting out
 * a retry backoff (`delayed`).
 */
const UNSETTLED_JUDGE_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'paused', 'waiting-children']);

/** Job states asked for at once, so a run with many unjudged results is not one round trip each. */
const BATCH_SIZE = 50;

/**
 * Whether any of these results still has a judge job that has not settled.
 *
 * Each result's job is looked up by its id ({@link judgeJobId}). `getJobState` is one
 * Redis script, and BullMQ moves a job between states inside one script too, so the answer
 * can never miss a job that is moving. Reading the queue a page at a time could: a job
 * picked up between two pages was on neither (review of issue #591). It also loaded every
 * queued judge job of every team, images included, to compare one field.
 *
 * A job that is still unsettled will end in a verdict or, once its attempts run out, in
 * the judge worker's terminal "judge call failed" marker. Either one counts as progress,
 * so a run must not be failed while such a job exists (issue #591).
 *
 * A judge job enqueued before job ids were set has a numeric id and is not found here, so
 * a run in flight across that deploy is judged by the plain stall window, as before #591.
 *
 * @param resultIds - The run's unjudged `eval_result` ids. Empty returns false without
 *   touching Redis.
 * @returns True if at least one of them has a judge job in a state that will run again.
 */
export async function hasUnsettledJudgeJob(resultIds: string[]): Promise<boolean> {
  const queue = getJudgeQueue();
  for (let i = 0; i < resultIds.length; i += BATCH_SIZE) {
    const states = await Promise.all(
      resultIds.slice(i, i + BATCH_SIZE).map((id) => queue.getJobState(judgeJobId(id))),
    );
    if (states.some((state) => UNSETTLED_JUDGE_STATES.has(state))) return true;
  }
  return false;
}
