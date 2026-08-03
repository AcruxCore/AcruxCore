import { Queue, type JobsOptions } from 'bullmq';
import { getRedisConnection } from '../../evaluations/queue/connection';
// `toEmailJobId` is named for its first caller but its constraint is BullMQ's, not
// email's: any custom job id containing exactly one `:` is rejected outright
// (job.js:1047-1049). Every queue in this codebase that wants a readable
// `prefix:id` dedupe key has to go through the same sanitizer, so it is reused
// here rather than duplicated.
import { toEmailJobId } from '../../email/email.queue';

/** Queue name for digest scheduling and per-team digest fan-out. */
export const DIGEST_QUEUE = 'digest';

/** Job name of the repeatable scheduler job. */
export const DIGEST_DISPATCH_JOB = 'digest-dispatch';

/** Job name of a single team's digest. */
export const DIGEST_TEAM_JOB = 'digest-team';

/**
 * The scheduler job's payload. Empty by design: the dispatch job derives its
 * window from the moment it runs, so there is nothing to carry and nothing that
 * can go stale if a job sits in the queue.
 */
export type DigestDispatchJobData = Record<string, never>;

/** One team's digest job. */
export interface DigestTeamJobData {
  teamId: string;
  /** Window start, ISO. Serialized as a string because the payload round-trips
   *  through Redis as JSON, which would hand the worker a string regardless. */
  from: string;
  /** Window end (exclusive), ISO. */
  to: string;
  /** ISO week the digest covers, e.g. `2026-W30`. Part of the job id. */
  isoWeek: string;
}

/** Either payload this queue carries. */
export type DigestJobData = DigestDispatchJobData | DigestTeamJobData;

/**
 * Job options for a per-team digest.
 *
 * Three attempts: an aggregate query can lose a database connection, and the
 * whole point of fanning out per team is that one team's transient failure
 * retries on its own without touching anyone else's digest.
 */
export const digestTeamJobOpts: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: 500,
  removeOnFail: 500,
};

let digestQueue: Queue<DigestJobData> | null = null;

/**
 * Get a memoized BullMQ Queue for digest jobs.
 *
 * @returns A singleton `Queue<DigestJobData>` on the shared Redis connection.
 */
export function getDigestQueue(): Queue<DigestJobData> {
  if (!digestQueue) {
    digestQueue = new Queue<DigestJobData>(DIGEST_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return digestQueue;
}

/**
 * Closes the digest queue if one was created, and forgets it.
 *
 * Test teardown only, mirroring `closeEmailQueue`.
 */
export async function closeDigestQueue(): Promise<void> {
  if (!digestQueue) return;
  const q = digestQueue;
  digestQueue = null;
  try {
    await q.close();
  } catch {
    // Already closed by a suite's own afterAll.
  }
}

/**
 * The per-team job id that guarantees one digest per team per week.
 *
 * @param teamId - The team.
 * @param isoWeek - Week identifier from `isoWeekKey`.
 * @returns A BullMQ-safe id, deterministic for that (team, week) pair.
 */
export function digestJobId(teamId: string, isoWeek: string): string {
  return toEmailJobId(`digest:${teamId}:${isoWeek}`);
}

/**
 * Registers (or removes) the weekly scheduler job.
 *
 * Existing repeatable entries for this job name are removed first, on every boot.
 * BullMQ keys a repeatable job by name **plus pattern**, so changing `DIGEST_CRON`
 * without this would leave the old schedule behind and the digest would fire on
 * both patterns — the classic way a "weekly" email becomes twice-weekly. Removing
 * first also makes `enabled: false` an actual kill switch rather than merely "we
 * stop adding it".
 *
 * Safe to call from every worker process: BullMQ stores one repeatable entry per
 * (name, pattern) in Redis, so N workers registering the identical schedule
 * produce one schedule, and the ISO-week job id catches anything that slipped
 * through anyway.
 *
 * @param config - Whether the schedule is enabled, and its cron pattern.
 * @returns Whether a schedule is now registered.
 * @throws {Error} When BullMQ rejects the cron pattern.
 */
export async function registerDigestSchedule(config: {
  enabled: boolean;
  cron: string;
}): Promise<boolean> {
  const queue = getDigestQueue();

  for (const entry of await queue.getRepeatableJobs()) {
    if (entry.name === DIGEST_DISPATCH_JOB) {
      await queue.removeRepeatableByKey(entry.key);
    }
  }

  if (!config.enabled) return false;

  await queue.add(
    DIGEST_DISPATCH_JOB,
    {} as DigestDispatchJobData,
    {
      repeat: { pattern: config.cron, tz: 'UTC' },
      // One fixed UTC time for everyone. Per-team local delivery needs a timezone
      // on the team or user, which does not exist.
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  );

  return true;
}
