import { Queue } from 'bullmq';
import { getRedisConnection } from '../../evaluations/queue/connection';

/** Queue name for the span-payload purge schedule. */
export const RETENTION_QUEUE = 'trace-payload-retention';

/** Job name of the repeatable purge job. */
export const RETENTION_PURGE_JOB = 'purge-span-payloads';

/**
 * The purge job's payload. Empty by design: the job derives its cutoff from
 * the moment it runs plus the configured retention window, so there is
 * nothing to carry and nothing that can go stale if a job sits in the queue.
 */
export type RetentionJobData = Record<string, never>;

let retentionQueue: Queue<RetentionJobData> | null = null;

/**
 * Get a memoized BullMQ Queue for the payload-purge schedule.
 *
 * @returns A singleton `Queue<RetentionJobData>` on the shared Redis connection.
 */
export function getRetentionQueue(): Queue<RetentionJobData> {
  if (!retentionQueue) {
    retentionQueue = new Queue<RetentionJobData>(RETENTION_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return retentionQueue;
}

/**
 * Closes the retention queue if one was created, and forgets it.
 *
 * Test teardown only, mirroring `closeDigestQueue`.
 */
export async function closeRetentionQueue(): Promise<void> {
  if (!retentionQueue) return;
  const q = retentionQueue;
  retentionQueue = null;
  try {
    await q.close();
  } catch {
    // Already closed by a suite's own afterAll.
  }
}

/**
 * Registers (or removes) the payload-purge repeatable job.
 *
 * Existing repeatable entries for this job name are removed first, on every
 * boot — mirrors `registerDigestSchedule`'s rationale: BullMQ keys a
 * repeatable job by name **plus pattern**, so changing the cron without this
 * would leave the old schedule behind and the job would fire on both
 * patterns. Removing first also makes `enabled: false` an actual kill switch.
 *
 * @param config - Whether the schedule is enabled, and its cron pattern.
 * @returns Whether a schedule is now registered.
 * @throws {Error} When BullMQ rejects the cron pattern.
 */
export async function registerRetentionSchedule(config: {
  enabled: boolean;
  cron: string;
}): Promise<boolean> {
  const queue = getRetentionQueue();

  for (const entry of await queue.getRepeatableJobs()) {
    if (entry.name === RETENTION_PURGE_JOB) {
      await queue.removeRepeatableByKey(entry.key);
    }
  }

  if (!config.enabled) return false;

  await queue.add(
    RETENTION_PURGE_JOB,
    {} as RetentionJobData,
    {
      repeat: { pattern: config.cron, tz: 'UTC' },
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  );

  return true;
}
