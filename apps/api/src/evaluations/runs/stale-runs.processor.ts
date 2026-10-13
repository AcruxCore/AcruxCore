import { RunsRepository } from './runs.repository';
import { notifyRunFinished } from './finalize.processor';
import { REAP_STALE_RUNS_JOB, type StaleRunsJobData } from './stale-runs.queue';

const runsRepo = new RunsRepository();

/**
 * Fails every run that is still `queued`/`running` but has made no progress for
 * `staleMinutes`, so a run whose queue jobs were lost ends in a visible state
 * instead of spinning forever.
 *
 * A run's final status is written only by queue jobs (the finalize job, or the
 * optimize worker's `failed` handler). When those jobs disappear — a worker killed
 * while holding an `attempts: 1` optimize job, Redis restarted or flushed — nothing
 * else ever touches the row. This sweep is that missing last resort.
 *
 * It cannot tell a lost run from a very slow one except by waiting, so the window
 * is deliberately long. If a "lost" run does turn out to be alive, its finalize job
 * still overwrites the status with the real result, because `processFinalize` writes
 * it unconditionally. Two leftovers in that rare case: the reaper's `error` text stays
 * on the row, and the run-finished email is not sent twice (same `run:<runId>` dedupe key).
 *
 * @param config - `{ staleMinutes }`, the idle time that makes a run stale.
 * @param now - The instant to measure from. Injectable so a test can pick the cutoff.
 * @returns The number of runs moved to `failed`.
 */
export async function reapStaleRuns(config: { staleMinutes: number }, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - config.staleMinutes * 60 * 1000);
  const error =
    `Run stopped: no progress for ${config.staleMinutes} minutes, and its background jobs are no longer running. ` +
    'Start the run again.';

  let reaped = 0;
  for (const runId of await runsRepo.findStaleRunIds(cutoff)) {
    const failed = await runsRepo.failRunIfStale(runId, cutoff, { endedAt: now, error });
    if (failed === 0) continue; // Made progress, or finalized, since it was listed.

    reaped += 1;
    try {
      await notifyRunFinished(runId, 'failed');
    } catch (err) {
      // The run is already failed; a notification problem must not stop the
      // sweep from reaching the remaining runs.
      console.error(`[stale-runs] failed to notify for run ${runId}`, err);
    }
  }
  return reaped;
}

/**
 * Runs one stale-run queue job, routed by job name — the same shape as
 * `processRetentionJob`, so the one-Worker-per-queue pattern holds here too.
 *
 * @param name - The BullMQ job name.
 * @param _data - The job payload (unused — the sweep carries no data).
 * @param config - The resolved stale-run config.
 * @param now - Dispatch time. Injectable for tests.
 * @throws {Error} On an unknown job name (a stale job from a previous build).
 */
export async function processStaleRunsJob(
  name: string,
  _data: StaleRunsJobData,
  config: { staleMinutes: number },
  now: Date = new Date(),
): Promise<void> {
  if (name === REAP_STALE_RUNS_JOB) {
    const reaped = await reapStaleRuns(config, now);
    if (reaped > 0) {
      console.warn(`[stale-runs] failed ${reaped} run(s) with no progress for ${config.staleMinutes}+ minutes`);
    }
    return;
  }

  throw new Error(`Unknown stale-runs job name: ${name}`);
}
