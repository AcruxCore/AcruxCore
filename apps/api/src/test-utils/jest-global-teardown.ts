import IORedis from 'ioredis';
import type { Config } from '@jest/types';
import { ownedRunQueuePrefix, workerRedisUrl } from './worker-isolation';

/**
 * Jest `globalTeardown`: deletes the BullMQ keys this run created.
 *
 * `jest-global-setup.ts` gives every run its own key prefix (issue #611), so no
 * later run ever reads these keys again. Without this step each run would leave
 * its queues' counters and kept jobs behind in Redis for good.
 *
 * Only keys under the prefix global setup generated are touched, on each Redis
 * database a worker could have used. A prefix the caller exported, or the
 * default `bull`, is left alone, because another process may own it.
 *
 * It never fails a run whose tests passed. A database no worker could use (the
 * base index is too low for that worker) is skipped, and so is a Redis that
 * cannot be reached: a run of pure-logic suites needs no Redis at all.
 *
 * @param globalConfig - Jest's resolved config; only `maxWorkers` is read.
 */
export default async function globalTeardown(globalConfig: Config.GlobalConfig): Promise<void> {
  const prefix = ownedRunQueuePrefix();
  if (!prefix) return;

  const baseUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  for (let workerId = 1; workerId <= globalConfig.maxWorkers; workerId++) {
    let url: string;
    try {
      url = workerRedisUrl(baseUrl, workerId);
    } catch {
      // jest-env.ts throws the same error in that worker, so it ran no suite.
      continue;
    }
    await deleteRunKeys(url, prefix);
  }
}

// Deletes `<prefix>:*` on one Redis database. One connection attempt, no retry.
async function deleteRunKeys(url: string, prefix: string): Promise<void> {
  const redis = new IORedis(url, {
    lazyConnect: true,
    retryStrategy: () => null,
    maxRetriesPerRequest: 0,
  });
  // A failed connect also emits 'error'; the rejected connect() below handles it.
  redis.on('error', () => {});
  try {
    try {
      await redis.connect();
    } catch (err) {
      console.warn(`Jest teardown: skipped BullMQ key cleanup on ${url}: ${(err as Error).message}`);
      return;
    }
    for await (const keys of redis.scanStream({ match: `${prefix}:*`, count: 500 })) {
      if ((keys as string[]).length > 0) await redis.unlink(...(keys as string[]));
    }
  } finally {
    redis.disconnect();
  }
}
