import '../src/shared/env/load-root-env';
import {
  getRedisConnection,
  getCellsQueue,
  getRunsQueue,
  getJudgeQueue,
  getOptimizeQueue,
} from '../src/evaluations/queue';

/**
 * Wipe every evaluation BullMQ queue in Redis (dev/ops utility).
 *
 * Obliterates the cells, runs, judge, and optimize queues — removing all jobs in
 * every state (waiting, delayed, active, completed, failed) plus the queue's own
 * bookkeeping keys. Intended for clearing a stale local queue: e.g. after the
 * database is reset, old jobs reference teams/runs that no longer exist and the
 * worker floods the log with foreign-key errors when it tries to record their
 * failure. This leaves all non-`bull:eval-*` Redis keys untouched.
 *
 * Reads `REDIS_URL` (defaults to `redis://localhost:6379`). Only the four eval
 * queues are affected — other BullMQ queues and unrelated keys are left alone.
 *
 * Run with: `npm run queues:clear -w @acruxcore/api`
 *
 * WARNING: destructive. Any genuinely pending eval work in these queues is
 * discarded. Meant for local/dev cleanup, not for a production queue with
 * in-flight jobs.
 */

/** One queue to obliterate, paired with a human label for logging. */
const queues = [
  { label: 'eval-cells', queue: getCellsQueue() },
  { label: 'eval-runs', queue: getRunsQueue() },
  { label: 'eval-judge', queue: getJudgeQueue() },
  { label: 'eval-optimize', queue: getOptimizeQueue() },
];

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  console.log(`Clearing eval queues on ${redisUrl} …`);

  for (const { label, queue } of queues) {
    // `force: true` obliterates even when jobs are locked/active — required to
    // clear a graveyard of stale failed jobs, which is the whole point here.
    await queue.obliterate({ force: true });
    console.log(`  ✓ obliterated ${label}`);
    await queue.close();
  }

  // Close the shared connection so the process can exit cleanly.
  await getRedisConnection().quit();
  console.log('✓ Eval queues cleared.');
}

main().catch((err: unknown) => {
  console.error('clear-eval-queues failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
