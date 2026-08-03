import { RetentionRepository } from './retention.repository';
import { RETENTION_PURGE_JOB, type RetentionJobData } from './retention.queue';

const repo = new RetentionRepository();

/**
 * Purges every `span_payloads` row older than the configured retention
 * window, relative to `now` (Finding #7).
 *
 * @param config - `{ retentionDays }` — the resolved retention window.
 * @param now - The instant to compute the cutoff from. Injectable so a test
 *   can drive a specific cutoff instead of depending on the clock.
 * @returns The number of `span_payloads` rows deleted.
 */
export async function processRetentionPurge(
  config: { retentionDays: number },
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - config.retentionDays * 24 * 60 * 60 * 1000);
  return repo.purgeOlderThan(cutoff);
}

/**
 * Runs one retention-queue job, routed by job name — mirrors `processDigest`'s
 * shape so the same single-Worker-per-queue pattern applies here too.
 *
 * @param name - The BullMQ job name.
 * @param _data - The job payload (unused — the purge job carries no data).
 * @param config - The resolved retention config.
 * @param now - Dispatch time. Injectable for tests.
 * @throws {Error} On an unknown job name (a stale job from a previous build).
 */
export async function processRetentionJob(
  name: string,
  _data: RetentionJobData,
  config: { retentionDays: number },
  now: Date = new Date(),
): Promise<void> {
  if (name === RETENTION_PURGE_JOB) {
    const deleted = await processRetentionPurge(config, now);
    console.log(`[trace-retention] purged ${deleted} span_payloads row(s) older than ${config.retentionDays}d`);
    return;
  }

  throw new Error(`Unknown retention job name: ${name}`);
}
