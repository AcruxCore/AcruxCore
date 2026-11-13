import { DelayedError, type Job } from 'bullmq';
import { positiveIntFromEnv } from '../../shared/env';

/**
 * Base wait (ms) before a job whose team is at its cap is offered to a worker again,
 * used until the team's own job time is known. After that, a team's parked jobs come
 * back about as often as its running ones finish.
 */
export const DEFAULT_TEAM_SLOT_RETRY_DELAY_MS = 2_000;

/** Shortest gap (ms) between two re-offers of one team's parked jobs. */
const MIN_REOFFER_GAP_MS = 50;

/** Weight of the newest job time in a team's running average. */
const JOB_TIME_SMOOTHING = 0.3;

/** Options for {@link withTeamSlot}. */
export interface TeamSlotOptions {
  /** Most jobs of one team this worker runs at once. At least 1. */
  maxPerTeam: number;
  /** Re-offer wait before a team's job time is known; defaults to {@link DEFAULT_TEAM_SLOT_RETRY_DELAY_MS}. */
  retryDelayMs?: number;
}

/** A BullMQ processor for a job whose payload names its team. */
export type TeamJobProcessor<T extends { teamId: string }> = (job: Job<T>, token?: string) => Promise<void>;

/**
 * The per-team cap a queue's worker should use.
 *
 * Every team's eval cells, judge calls and online-eval jobs share one queue each,
 * consumed at a fixed concurrency. Without a per-team cap, one team's backlog (or a
 * slow `base_url` of its own) takes every slot, and every other team's jobs wait
 * behind it. Half the worker's concurrency leaves the other half for everyone else.
 * The cap applies in each worker process, so adding processes adds to one team's
 * share in the same proportion as to everyone's.
 *
 * @param workerConcurrency - The queue's worker concurrency (positive).
 * @returns `EVAL_PER_TEAM_MAX_IN_FLIGHT` when it is a positive integer (a set but unusable
 *   value is warned about), else half of
 *   `workerConcurrency`, rounded down, and never below 1. Setting the variable to the
 *   worker concurrency or higher turns the cap off (a single-team install may want that).
 */
export function perTeamInFlightCap(workerConcurrency: number): number {
  return positiveIntFromEnv('EVAL_PER_TEAM_MAX_IN_FLIGHT') ?? Math.max(1, Math.floor(workerConcurrency / 2));
}

/**
 * Wraps a queue's processor so this worker never runs more than `maxPerTeam` of one
 * team's jobs at once.
 *
 * The count is kept in this process, for this worker's own slots, which is what the cap
 * protects; a process that dies takes its count with it, so nothing can leak.
 *
 * A job whose team is at its cap does not wait inside its worker slot: it is moved
 * back to `delayed` (without using an attempt) and the slot takes the next job, which
 * may be another team's. Parked jobs are spread out rather than all sent back after
 * the same wait: each one is scheduled one gap after the team's previous one, where
 * the gap is the team's average job time divided by its cap, so they come back at
 * roughly the rate the team's running jobs finish. Re-delaying every parked job every
 * few seconds instead cycled a large backlog through Redis thousands of times a second.
 *
 * Called without a worker lock token (an in-process call, not a BullMQ Worker), the
 * processor runs ungated: there is no shared worker slot to protect.
 *
 * @param queueName - The queue's name; kept for logs and symmetry with the worker wiring.
 * @param processor - The real processor.
 * @param opts - The cap and the initial re-offer wait.
 * @returns A processor with the same signature, for `new Worker(queueName, …)`.
 * @throws {DelayedError} When the team is at its cap: BullMQ's signal that the job
 *   moved itself to `delayed`. Otherwise whatever `processor` throws, unchanged.
 */
export function withTeamSlot<T extends { teamId: string }>(
  queueName: string,
  processor: TeamJobProcessor<T>,
  opts: TeamSlotOptions,
): TeamJobProcessor<T> {
  void queueName;
  const retryDelay = opts.retryDelayMs ?? DEFAULT_TEAM_SLOT_RETRY_DELAY_MS;
  const cap = Math.max(1, Math.floor(opts.maxPerTeam));
  const running = new Map<string, number>();
  const nextOfferAt = new Map<string, number>();
  const jobTimeMs = new Map<string, number>();

  return async (job, token) => {
    if (!token) return processor(job, token);

    const team = job.data.teamId;
    const now = Date.now();
    if ((running.get(team) ?? 0) >= cap) {
      const gap = Math.max(MIN_REOFFER_GAP_MS, (jobTimeMs.get(team) ?? retryDelay) / cap);
      const at = Math.max(now, nextOfferAt.get(team) ?? 0) + gap;
      nextOfferAt.set(team, at);
      await job.moveToDelayed(at, token);
      throw new DelayedError();
    }

    running.set(team, (running.get(team) ?? 0) + 1);
    const started = Date.now();
    try {
      await processor(job, token);
    } finally {
      const left = (running.get(team) ?? 1) - 1;
      const took = Date.now() - started;
      const avg = jobTimeMs.get(team);
      jobTimeMs.set(team, avg === undefined ? took : avg + JOB_TIME_SMOOTHING * (took - avg));
      if (left > 0) {
        running.set(team, left);
      } else {
        running.delete(team);
        // A team with nothing running and nothing scheduled ahead is forgotten, so the
        // maps hold only teams with work in flight.
        if ((nextOfferAt.get(team) ?? 0) <= Date.now()) {
          nextOfferAt.delete(team);
          jobTimeMs.delete(team);
        }
      }
    }
  };
}
