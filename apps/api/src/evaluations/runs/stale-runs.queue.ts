import { Queue } from 'bullmq';
import { getRedisConnection } from '../queue/connection';

/** Queue name for the stale-run sweep schedule. */
export const STALE_RUNS_QUEUE = 'eval-stale-runs';

/** Job name of the repeatable sweep job. */
export const REAP_STALE_RUNS_JOB = 'reap-stale-runs';

/**
 * The sweep job's payload. Empty by design: the cutoff is computed from the moment
 * the job runs, so nothing can go stale while a job waits in the queue.
 */
export type StaleRunsJobData = Record<string, never>;

let staleRunsQueue: Queue<StaleRunsJobData> | null = null;

/**
 * Get a memoized BullMQ Queue for the stale-run sweep schedule.
 *
 * @returns A singleton `Queue<StaleRunsJobData>` on the shared Redis connection.
 */
export function getStaleRunsQueue(): Queue<StaleRunsJobData> {
  if (!staleRunsQueue) {
    staleRunsQueue = new Queue<StaleRunsJobData>(STALE_RUNS_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return staleRunsQueue;
}

/**
 * Closes the stale-run queue if one was created, and forgets it. Test teardown only.
 */
export async function closeStaleRunsQueue(): Promise<void> {
  if (!staleRunsQueue) return;
  const q = staleRunsQueue;
  staleRunsQueue = null;
  try {
    await q.close();
  } catch {
    // Already closed by a suite's own afterAll.
  }
}

/**
 * Registers (or removes) the stale-run sweep repeatable job.
 *
 * Existing entries for this job name are removed first, on every boot, for the
 * same reasons as `registerRetentionSchedule`: BullMQ keys a repeatable job by
 * name plus pattern, so a changed cron would otherwise leave the old schedule
 * running, and removing first is what makes `enabled: false` a real kill switch.
 * Call it before starting a Worker on `STALE_RUNS_QUEUE`, and await it.
 *
 * @param config - Whether the schedule is enabled, and its cron pattern.
 * @returns Whether a schedule is now registered.
 * @throws {Error} When BullMQ rejects the cron pattern.
 */
export async function registerStaleRunSchedule(config: { enabled: boolean; cron: string }): Promise<boolean> {
  const queue = getStaleRunsQueue();

  for (const entry of await queue.getRepeatableJobs()) {
    if (entry.name === REAP_STALE_RUNS_JOB) {
      await queue.removeRepeatableByKey(entry.key);
    }
  }

  if (!config.enabled) return false;

  await queue.add(REAP_STALE_RUNS_JOB, {} as StaleRunsJobData, {
    repeat: { pattern: config.cron, tz: 'UTC' },
    removeOnComplete: 20,
    removeOnFail: 20,
  });

  return true;
}
