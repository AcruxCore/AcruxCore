import { createHash } from 'node:crypto';
import { Queue, type JobsOptions } from 'bullmq';
import { getRedisConnection } from '../evaluations/queue/connection';
import type { EmailPayload } from './email.types';

/** Queue name for outbound product email. */
export const EMAIL_QUEUE = 'email';

/** Data payload for one outbound email job. */
export interface EmailJobData {
  /** `email_log` row this job settles. */
  emailLogId: string;
  /** Team the email belongs to (tenant isolation). */
  teamId: string;
  /** Single recipient address. */
  to: string;
  /**
   * Template key + props. Rendered in the worker rather than carried as HTML:
   * rendering is pure and cheap, and a small payload keeps Redis small.
   */
  payload: EmailPayload;
}

/**
 * Job options for every email job.
 *
 * Email is the textbook retry workload — SES throttling and transient 5xx are
 * normal operation — so five attempts with exponential backoff from 5s.
 */
export const emailJobOpts: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

/**
 * Turns a caller-supplied `dedupeKey` into a value BullMQ will accept as a
 * custom job id.
 *
 * Two jobs must get the same id if and only if they have the same
 * `dedupeKey`. A plain `:` → `_` substitution is NOT injective — `invite:a_b`
 * and `invite_a:b` would both become `invite_a_b`, colliding and silently
 * dropping the second email — and BullMQ's `Job.validateOptions` (5.x) throws
 * `Custom Id cannot contain :` for any custom job id containing exactly one
 * `:` (job.js:1047–1049; it only tolerates a colon when the id splits into
 * exactly three parts, a carve-out for its own legacy repeatable-job id
 * format, not for arbitrary caller ids). So: a readable slug for eyeballing
 * the queue in Redis, plus a hash suffix that actually guarantees uniqueness
 * — the slug alone is never relied on to distinguish two different keys.
 *
 * @param dedupeKey - The caller's idempotency key, e.g. `invite:<inviteId>`.
 * @returns A BullMQ-safe job id, deterministic for a given `dedupeKey` and
 *   collision-free across different ones.
 */
export function toEmailJobId(dedupeKey: string): string {
  const slug = dedupeKey.replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 48);
  const hash = createHash('sha256').update(dedupeKey).digest('hex').slice(0, 16);
  return `${slug}-${hash}`;
}

let emailQueue: Queue<EmailJobData> | null = null;

/**
 * Get a memoized BullMQ Queue for outbound email jobs.
 *
 * @returns A singleton `Queue<EmailJobData>` on the shared Redis connection.
 */
export function getEmailQueue(): Queue<EmailJobData> {
  if (!emailQueue) {
    emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE, { connection: getRedisConnection() });
  }
  return emailQueue;
}

/**
 * Closes the email queue if one was created, and forgets it.
 *
 * Test teardown only — see `closeRedisConnection`'s docstring for why an
 * unclosed queue makes a passing suite hang. Closing a `Queue` does NOT quit the
 * caller-supplied ioredis instance it was built on, so both must be closed.
 */
export async function closeEmailQueue(): Promise<void> {
  if (!emailQueue) return;
  const q = emailQueue;
  emailQueue = null;
  try {
    await q.close();
  } catch {
    // Already closed by a suite's own afterAll.
  }
}

/**
 * Runs every waiting email job through `processEmail` and removes it.
 *
 * The test-suite equivalent of the worker: it keeps tests exercising the real
 * enqueue → render → transport → `email_log` path without booting a Worker and
 * waiting on its timing. Only ever called from tests.
 *
 * @returns The number of jobs processed.
 * @throws {Error} Whatever a job's delivery threw, so a test can assert on it.
 */
export async function drainEmailQueue(): Promise<number> {
  // Imported lazily so that a direct, barrel-bypassing importer of this file
  // (e.g. `email.service.ts`, which imports `getEmailQueue`/`emailJobOpts`
  // straight from here) does not transitively load `email.processor` — and
  // therefore the SES transport — merely by needing the queue helpers.
  //
  // This does NOT make the API process itself avoid loading the transport:
  // `email/index.ts` re-exports `email.processor` eagerly (`export * from
  // './email.processor'`), and `invites.router.ts` imports from that barrel
  // at boot, so `@aws-sdk/client-sesv2` is already pulled into the API
  // process either way. The barrel export stays eager because the worker
  // needs `processEmail` from it — this package's `exports` map in
  // `package.json` only declares the `./email` barrel subpath, not
  // `./email/email.processor`, so the worker cannot import the processor
  // directly (confirmed: `require('@acruxcore/api/email/email.processor')`
  // throws `ERR_PACKAGE_PATH_NOT_EXPORTED`).
  const { processEmail } = await import('./email.processor');
  const jobs = await getEmailQueue().getJobs(['waiting', 'delayed', 'paused']);
  for (const job of jobs) {
    try {
      await processEmail(job.data);
    } finally {
      await job.remove();
    }
  }
  return jobs.length;
}
