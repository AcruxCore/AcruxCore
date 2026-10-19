import { RetentionRepository } from './retention.repository';
import { CACHE_PURGE_JOB, RETENTION_PURGE_JOB, type RetentionJobData } from './retention.queue';
// The concrete file, not the `gateway/cache` barrel: the barrel re-exports the
// cache router, and this processor runs inside apps/worker, which stays
// Express-free.
import { CacheRepository } from '../../gateway/cache/cache.repository';

const repo = new RetentionRepository();
const cacheRepo = new CacheRepository();

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
 * shape so the same single-Worker-per-queue pattern applies here too. Two jobs
 * share the queue: the span-payload purge and the expired-cache sweep
 * (issue #652).
 *
 * @param name - The BullMQ job name.
 * @param _data - The job payload (unused — neither job carries data).
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

  if (name === CACHE_PURGE_JOB) {
    const deleted = await cacheRepo.purgeExpired(now);
    console.log(`[gateway-cache] purged ${deleted} expired gateway_cache row(s)`);
    return;
  }

  throw new Error(`Unknown retention job name: ${name}`);
}
