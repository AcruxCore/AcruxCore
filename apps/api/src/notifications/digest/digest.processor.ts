import { DigestRepository } from './digest.repository';
import { DigestService } from './digest.service';
import {
  DIGEST_DISPATCH_JOB,
  DIGEST_TEAM_JOB,
  type DigestJobData,
  type DigestTeamJobData,
} from './digest.queue';

const service = new DigestService(new DigestRepository());

/**
 * Runs one digest-queue job: either the weekly scheduler, or one team's digest.
 *
 * Both job kinds share a queue so a single Worker consumes them, but they are
 * routed by job name rather than by inspecting the payload — the scheduler's
 * payload is deliberately empty and could not be told apart otherwise.
 *
 * @param name - The BullMQ job name.
 * @param data - The job payload.
 * @param now - Dispatch time. Injectable so a test can drive a specific window
 *   instead of depending on the clock.
 * @throws {Error} On an unknown job name (a stale job from a previous build), and
 *   on any database failure — both retryable, which is what the per-team job's
 *   `attempts` exist for.
 */
export async function processDigest(
  name: string,
  data: DigestJobData,
  now: Date = new Date(),
): Promise<void> {
  if (name === DIGEST_DISPATCH_JOB) {
    const { current } = DigestService.windows(now);
    const count = await service.dispatch(now);
    console.log(
      `[digest] dispatched ${count} team digest(s) for ${current.from.toISOString()} → ${current.to.toISOString()}`,
    );
    return;
  }

  if (name === DIGEST_TEAM_JOB) {
    const job = data as DigestTeamJobData;
    const sent = await service.send(
      job.teamId,
      { from: new Date(job.from), to: new Date(job.to) },
      job.isoWeek,
    );
    console.log(`[digest] team ${job.teamId} ${job.isoWeek}: ${sent} email(s) enqueued`);
    return;
  }

  throw new Error(`Unknown digest job name: ${name}`);
}
