// Must stay the first import: it populates process.env before any module below
// reads it (the email transport, the database URL, the digest schedule).
import './env';
import { Sentry } from './monitoring';
import { Worker, type Job } from 'bullmq';
import {
  getRedisConnection,
  EVAL_CELLS_QUEUE,
  EVAL_RUNS_QUEUE,
  EVAL_JUDGE_QUEUE,
  EVAL_OPTIMIZE_QUEUE,
  type CellJobData,
  type FinalizeJobData,
  type JudgeJobData,
  type OptimizeJobData,
} from '@acruxcore/api/evaluations/queue';
import {
  processCell,
  processFinalize,
  processJudge,
  processOptimize,
  markFinalizeExhausted,
  RunsRepository,
} from '@acruxcore/api/evaluations/runs/processors';
import { ONLINE_EVAL_QUEUE, type OnlineEvalJobData } from '@acruxcore/api/evaluations/online/queue';
import { processOnlineEval } from '@acruxcore/api/evaluations/online/processor';
import {
  EMAIL_QUEUE,
  assertEmailConfig,
  assertUnsubscribeSecret,
  processEmail,
  type EmailJobData,
} from '@acruxcore/api/email';
import {
  DIGEST_QUEUE,
  loadDigestConfig,
  processDigest,
  registerDigestSchedule,
  type DigestJobData,
} from '@acruxcore/api/notifications/digest';
import {
  RETENTION_QUEUE,
  loadRetentionConfig,
  processRetentionJob,
  registerRetentionSchedule,
  type RetentionJobData,
} from '@acruxcore/api/traces/retention';

/** The eight live BullMQ Workers booted by {@link startWorkers}. */
export interface EvalWorkers {
  /** Consumes `EVAL_CELLS_QUEUE`, running one gateway call per grid x example cell. */
  cellWorker: Worker<CellJobData>;
  /** Consumes `EVAL_RUNS_QUEUE`, finalizing a run once all its cell jobs have settled. */
  runWorker: Worker<FinalizeJobData>;
  /** Consumes `EVAL_JUDGE_QUEUE`, scoring one produced `eval_result` per job via `JudgeService`. */
  judgeWorker: Worker<JudgeJobData>;
  /** Consumes `EVAL_OPTIMIZE_QUEUE` (E6), drafting candidates and enqueuing the cell/finalize Flow. */
  optimizeWorker: Worker<OptimizeJobData>;
  /** Consumes `ONLINE_EVAL_QUEUE`, scoring live-gateway spans against enabled eval rules. */
  onlineEvalWorker: Worker<OnlineEvalJobData>;
  /** Consumes `EMAIL_QUEUE`, sending one product email per job. */
  emailWorker: Worker<EmailJobData>;
  /** Consumes `DIGEST_QUEUE`: the weekly scheduler job plus its per-team fan-out. */
  digestWorker: Worker<DigestJobData>;
  /** Consumes `RETENTION_QUEUE`: the daily `span_payloads` purge job (Finding #7). */
  retentionWorker: Worker<RetentionJobData>;
}

const runsRepo = new RunsRepository();

/**
 * Boots the three BullMQ Workers that execute experiment-run jobs in this
 * process. All three consume the exact same `processCell`/`processFinalize`/
 * `processJudge` functions built for in-process execution (Task 4 of the E3
 * plan, plus judging wired in by Task 4 of the E4 plan) — this file
 * constructs no `GatewayService`/`JudgeService` of its own, so budgets, rate
 * limits, and the cost ledger are enforced identically whether a cell or
 * judge call runs here or in-process inside the API. Running them in a
 * separate process only changes *where* the same code executes, letting this
 * worker be deployed/scaled independently of the API.
 *
 * `cellWorker` bounds concurrency via `EVAL_WORKER_CONCURRENCY` (default 2):
 * concurrency here means simultaneously in-flight gateway calls, so it must
 * stay low enough not to blow through provider rate limits. Its `'failed'`
 * handler writes a terminal `eval_result` error row via
 * `RunsRepository.writeResultError` only once a job has exhausted its
 * configured retry attempts (`attemptsMade >= attempts`) — `processCell`
 * itself never writes that row (retryable failures must not get a premature
 * terminal row; see its own docstring).
 *
 * `runWorker` runs `processFinalize` at a fixed concurrency of 1: only one
 * run finalizes at a time, and finalize is cheap (no gateway call). It
 * retries (via the finalize job's own `attempts`/`backoff`, set in
 * `runs.service.ts`'s `startRun`) until every cell's judge job has also
 * settled — see `processFinalize`'s docstring. Its `'failed'` handler fires
 * only once those retries are genuinely exhausted (moderate-sized runs at low
 * concurrency, a backed-up judge queue, or a permanent judge outage can all
 * burn through the whole retry budget before judging finishes): once
 * `job.attemptsMade >= job.opts.attempts`, it delegates to apps/api's
 * `markFinalizeExhausted` (see that function's own docstring), which
 * transitions the run to a real terminal `failed` status with an
 * operator-visible `error` message instead of leaving it stuck at `queued`
 * forever.
 *
 * `judgeWorker` consumes `EVAL_JUDGE_QUEUE`, one `JudgeService.scoreResult`
 * call per produced `eval_result`, bounded by its OWN `EVAL_JUDGE_WORKER_CONCURRENCY`
 * env var (default 2) — a separate knob from `cellWorker`'s
 * `EVAL_WORKER_CONCURRENCY`, so the two simultaneous-gateway-call ceilings
 * (cell generation calls vs. judge calls) are independently tunable. Judge
 * calls go through the identical gateway path as cell calls, so this still
 * bounds "how many simultaneous gateway calls" — just for judge traffic only;
 * the real combined ceiling across both workers is
 * `EVAL_WORKER_CONCURRENCY + EVAL_JUDGE_WORKER_CONCURRENCY`, not either value
 * alone. Its `'failed'` handler mirrors `cellWorker`'s: once a judge job has
 * exhausted its attempts (e.g. `JudgeService.scoreResult` rethrew a
 * budget/rate-limit error, which it never swallows), it writes a terminal
 * "judge call failed" marker onto the `eval_result` row via
 * `RunsRepository.writeVerdict` — without this, that row would never gain a
 * non-null `score`/`reason`, and `processFinalize`'s readiness check would
 * retry forever.
 *
 * `optimizeWorker` consumes `EVAL_OPTIMIZE_QUEUE` (E6), one
 * `processOptimize` call per optimize attempt, bounded by its OWN
 * `EVAL_OPTIMIZE_WORKER_CONCURRENCY` env var (default 2) — a separate knob
 * from `cellWorker`/`judgeWorker`'s, for the same reason: each makes its own
 * simultaneous gateway calls, so each gets an independently tunable ceiling.
 * Its `'failed'` handler mirrors `runWorker`'s: since nothing else ever
 * transitions a run out of `queued` once `processOptimize` never even gets to
 * resolve a grid, a permanently failed optimize job (attempts exhausted)
 * would otherwise leave the run stuck at `queued` forever with no
 * operator-visible signal — so it marks the run `failed` directly via
 * `RunsRepository.setRunStatus`.
 *
 * `emailWorker` consumes `EMAIL_QUEUE`, one `processEmail` call per outbound
 * product email, bounded by `EMAIL_WORKER_CONCURRENCY` (default 5) — email is
 * one SES API call each, so concurrency here is "simultaneous SES calls",
 * which the default keeps well under SES's default per-second send rate. It
 * has no `'failed'` handler: `EmailService.deliver` already writes the failure
 * onto the `email_log` row before rethrowing, so there is no terminal state
 * left for BullMQ to record.
 *
 * `retentionWorker` consumes `RETENTION_QUEUE` (Finding #7), one
 * `processRetentionJob` call per scheduled purge, at concurrency 1 — a plain
 * delete-by-cutoff query, so there is never more than one purge in flight. No
 * `'failed'` handler: a failed purge has no terminal state to record, and the
 * next scheduled run tries again with a (by then more overdue) cutoff.
 *
 * @returns The seven live `Worker` instances, so callers (the e2e test, or a
 *   standalone process shutting down) can `.close()` them.
 */
/**
 * Waits for a just-constructed Worker's Redis connection to report ready,
 * throwing if it doesn't within `timeoutMs`.
 *
 * This exists because of a real incident: booting all six Workers back-to-back
 * in the same tick — each internally duplicating the shared `getRedisConnection()`
 * instance for its own blocking connection — has been observed, under
 * production load from everything else importing at process start (Prisma via
 * `RunsRepository`, nodemailer/SES via the email module), to leave one
 * Worker's connection simply never finishing — no thrown error, no rejected
 * promise, nothing emitted on `'error'`. That Worker's queue (it happened to
 * be the email queue) sat permanently unconsumed with zero operator-visible
 * signal; only a manual Redis inspection surfaced it.
 * `startWorkers` now awaits this after each Worker it constructs, which (a)
 * sequences connection setup so boot never has multiple connections racing at
 * once, and (b) turns a silent hang into a loud, restart-triggering failure if
 * one happens anyway.
 *
 * @param worker - The just-constructed Worker to wait on.
 * @param timeoutMs - How long to wait before giving up.
 * @throws {Error} If `worker` does not emit `'ready'` within `timeoutMs`.
 */
async function waitForWorkerReady(worker: Worker, timeoutMs = 15000): Promise<void> {
  // Safe against missing the event: BullMQ's Worker always defers its own
  // 'ready' emission by one macrotask (`setTimeout(..., 0)` on the underlying
  // connection's 'ready'), and this function is always called synchronously
  // right after `new Worker(...)` — so the `.once` below is guaranteed to
  // attach before 'ready' can possibly fire.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Worker for queue "${worker.name}" did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);
    worker.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function startWorkers(): Promise<EvalWorkers> {
  const connection = getRedisConnection();
  const concurrency = Number(process.env.EVAL_WORKER_CONCURRENCY ?? 2);
  const judgeConcurrency = Number(process.env.EVAL_JUDGE_WORKER_CONCURRENCY ?? 2);
  const optimizeConcurrency = Number(process.env.EVAL_OPTIMIZE_WORKER_CONCURRENCY ?? 2);

  const cellWorker = new Worker<CellJobData>(EVAL_CELLS_QUEUE, (job) => processCell(job.data), {
    connection,
    concurrency,
  });
  cellWorker.on('error', (err) => {
    console.error(`[${cellWorker.name}] worker error`, err);
    Sentry.captureException(err);
  });

  cellWorker.on('failed', async (job: Job<CellJobData> | undefined, error: Error) => {
    if (!job) return;

    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return; // more retries scheduled — not terminal yet

    Sentry.captureException(error);
    try {
      await runsRepo.writeResultError({
        teamId: job.data.teamId,
        experimentRunId: job.data.runId,
        datasetExampleId: job.data.exampleId,
        variantKind: job.data.variantKind,
        promptVersionId: job.data.promptVersionId,
        variantLabel: job.data.variantLabel,
        model: job.data.model,
        errorMessage: job.failedReason ?? 'Unknown error',
      });
    } catch (err) {
      // Never let a failure to write the terminal error row (e.g. an FK
      // violation from a stale job whose team/run no longer exists) throw
      // out of this event handler — an unhandled rejection here crashes the
      // whole worker process, taking down all four queues over one job.
      console.error('[cellWorker] failed to write terminal error row', err);
    }
  });
  await waitForWorkerReady(cellWorker);

  const runWorker = new Worker<FinalizeJobData>(EVAL_RUNS_QUEUE, (job) => processFinalize(job.data), {
    connection,
    concurrency: 1,
  });
  runWorker.on('error', (err) => {
    console.error(`[${runWorker.name}] worker error`, err);
    Sentry.captureException(err);
  });

  runWorker.on('failed', async (job: Job<FinalizeJobData> | undefined, error: Error) => {
    if (!job) return;

    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return; // more retries scheduled — not terminal yet

    Sentry.captureException(error);
    // The actual state-transition/error-message logic lives in apps/api's
    // `markFinalizeExhausted` (finalize.processor.ts) so it stays unit
    // testable without needing this package's compiled `dist/` output — this
    // handler only owns the generic BullMQ "are retries truly exhausted"
    // check above, mirroring cellWorker/judgeWorker's handlers.
    try {
      await markFinalizeExhausted(job.data, job.failedReason);
    } catch (err) {
      console.error('[runWorker] failed to mark run as finalize-exhausted', err);
    }
  });
  await waitForWorkerReady(runWorker);

  const judgeWorker = new Worker<JudgeJobData>(EVAL_JUDGE_QUEUE, (job) => processJudge(job.data), {
    connection,
    concurrency: judgeConcurrency,
  });
  judgeWorker.on('error', (err) => {
    console.error(`[${judgeWorker.name}] worker error`, err);
    Sentry.captureException(err);
  });

  judgeWorker.on('failed', async (job: Job<JudgeJobData> | undefined, error: Error) => {
    if (!job) return;

    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return; // more retries scheduled — not terminal yet

    Sentry.captureException(error);
    try {
      await runsRepo.writeVerdict(job.data.resultId, {
        score: null,
        passed: null,
        reason: `judge call failed: ${job.failedReason ?? 'unknown error'}`,
        judgeTraceId: null,
      });
    } catch (err) {
      console.error('[judgeWorker] failed to write terminal verdict', err);
    }
  });
  await waitForWorkerReady(judgeWorker);

  const onlineEvalConcurrency = Number(process.env.ONLINE_EVAL_WORKER_CONCURRENCY ?? 2);
  const onlineEvalWorker = new Worker<OnlineEvalJobData>(
    ONLINE_EVAL_QUEUE,
    (job) => processOnlineEval(job.data),
    { connection, concurrency: onlineEvalConcurrency },
  );
  onlineEvalWorker.on('error', (err) => {
    console.error('[online-eval-worker] error', err);
    Sentry.captureException(err);
  });
  await waitForWorkerReady(onlineEvalWorker);

  const optimizeWorker = new Worker<OptimizeJobData>(EVAL_OPTIMIZE_QUEUE, (job) => processOptimize(job.data), {
    connection,
    concurrency: optimizeConcurrency,
  });
  optimizeWorker.on('error', (err) => {
    console.error(`[${optimizeWorker.name}] worker error`, err);
    Sentry.captureException(err);
  });

  optimizeWorker.on('failed', async (job: Job<OptimizeJobData> | undefined, error: Error) => {
    if (!job) return;

    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return; // more retries scheduled — not terminal yet

    Sentry.captureException(error);
    try {
      await runsRepo.setRunStatus(job.data.runId, 'failed', {
        endedAt: new Date(),
        error: `optimize job failed: ${job.failedReason ?? 'unknown error'}`,
      });
    } catch (err) {
      console.error('[optimizeWorker] failed to mark run as failed', err);
    }
  });
  await waitForWorkerReady(optimizeWorker);

  // Email jobs are one SES API call each, so concurrency here is "simultaneous
  // SES calls" — the default of 5 stays well under SES's default per-second
  // send rate. No `'failed'` handler: `EmailService.deliver` already writes the
  // failure onto the `email_log` row before rethrowing, so there is no terminal
  // state left for BullMQ to record.
  const emailWorker = new Worker<EmailJobData>(EMAIL_QUEUE, (job) => processEmail(job.data), {
    connection,
    concurrency: Number(process.env.EMAIL_WORKER_CONCURRENCY ?? 5),
  });
  emailWorker.on('error', (err) => {
    console.error(`[${emailWorker.name}] worker error`, err);
    Sentry.captureException(err);
  });
  await waitForWorkerReady(emailWorker);

  // Digest jobs come in two shapes on one queue — the weekly scheduler and one
  // job per team — routed by job name inside `processDigest`. Concurrency 2:
  // these are aggregate queries, so a handful of teams' digests can build in
  // parallel without turning Monday 08:00 into a database spike. No `'failed'`
  // handler: a failed digest has no terminal state to record beyond BullMQ's own,
  // and the per-team `attempts` already retry it.
  const digestWorker = new Worker<DigestJobData>(
    DIGEST_QUEUE,
    (job) => processDigest(job.name, job.data),
    { connection, concurrency: Number(process.env.DIGEST_WORKER_CONCURRENCY ?? 2) },
  );
  digestWorker.on('error', (err) => {
    console.error(`[${digestWorker.name}] worker error`, err);
    Sentry.captureException(err);
  });
  await waitForWorkerReady(digestWorker);

  // One purge sweep a day (default schedule) deleting expired `span_payloads`
  // rows — a plain delete-by-cutoff query, so concurrency 1 is plenty; there is
  // never more than one purge job in flight at a time. No `'failed'` handler:
  // a failed purge has no terminal state to record, and the next scheduled run
  // simply tries again with a (by then, even more overdue) cutoff.
  const retentionConfig = loadRetentionConfig();
  const retentionWorker = new Worker<RetentionJobData>(
    RETENTION_QUEUE,
    (job) => processRetentionJob(job.name, job.data, { retentionDays: retentionConfig.retentionDays }),
    { connection, concurrency: 1 },
  );
  retentionWorker.on('error', (err) => console.error(`[${retentionWorker.name}] worker error`, err));
  await waitForWorkerReady(retentionWorker);

  return { cellWorker, runWorker, judgeWorker, onlineEvalWorker, optimizeWorker, emailWorker, digestWorker, retentionWorker };
}

/* Standalone process entrypoint — not exercised when imported by the e2e test. */
if (require.main === module) {
  // Fail fast on a misconfigured email environment. The worker — not the API
  // — is the process that actually attempts SES delivery, so this is the
  // guard that matters: without it, a worker missing SES_REGION/etc. boots
  // happily and fails every email job silently instead of crash-looping with
  // a clear message at startup, the same contract `apps/api/server.ts`
  // already enforces for the request path.
  assertEmailConfig();
  // Every digest and notification body carries an unsubscribe link, so a worker
  // without this secret would mail links it cannot honour. Same fail-fast
  // contract, in the same process that actually renders and sends.
  assertUnsubscribeSecret();

  // `startWorkers()` now awaits each Worker's Redis connection before starting
  // the next (see `waitForWorkerReady`'s docstring for the incident that
  // motivated this), which makes it async — so the rest of boot lives inside
  // this IIFE. If `startWorkers()` rejects (a connection never became ready),
  // this `.catch` logs it loudly and exits non-zero rather than leaving a
  // half-booted process running with a queue nobody is consuming.
  void (async () => {
    const workers = await startWorkers();

    // Register the weekly digest schedule on boot. Existing repeatable entries
    // for this job are removed first, so a changed `DIGEST_CRON` replaces the
    // schedule rather than adding a second one — see `registerDigestSchedule`.
    const digestConfig = loadDigestConfig();
    void registerDigestSchedule(digestConfig)
      .then((registered) => {
        console.log(
          registered
            ? `[worker] weekly digest scheduled (${digestConfig.cron} UTC)`
            : '[worker] weekly digest disabled (DIGEST_ENABLED)',
        );
      })
      .catch((err) => {
        // A bad cron pattern must be loud, but it must not take the other five
        // queues down with it — they have nothing to do with the digest.
        console.error('[worker] failed to register the digest schedule', err);
      });

    // Last-resort process guards. `'failed'`/`'error'` handlers above cover the
    // expected failure paths, but a genuinely stray async error must still not
    // silently kill the worker: log an unhandled rejection (Node >=15 would
    // otherwise terminate the process), and on a truly uncaught exception log it
    // and exit non-zero so a supervisor restarts a clean process rather than one
    // left in an unknown state.
    process.on('unhandledRejection', (reason) => {
      console.error('[worker] unhandledRejection', reason);
      Sentry.captureException(reason);
    });
    process.on('uncaughtException', (err) => {
      console.error('[worker] uncaughtException', err);
      Sentry.captureException(err);
      // Give the SDK a chance to flush the event over the network before the
      // process exits — without this, capturing right before exit(1) is a
      // race that usually loses.
      void Sentry.close(2000).finally(() => process.exit(1));
    });

    // Register the daily span_payloads purge schedule on boot (Finding #7), same
    // remove-then-add pattern as the digest schedule above.
    const retentionScheduleConfig = loadRetentionConfig();
    void registerRetentionSchedule(retentionScheduleConfig)
      .then((registered) => {
        console.log(
          registered
            ? `[worker] trace payload purge scheduled (${retentionScheduleConfig.cron} UTC, ${retentionScheduleConfig.retentionDays}d retention)`
            : '[worker] trace payload purge disabled (TRACE_PAYLOAD_PURGE_ENABLED)',
        );
      })
      .catch((err) => {
        console.error('[worker] failed to register the trace payload purge schedule', err);
      });

    // Graceful shutdown: on SIGTERM/SIGINT stop pulling new jobs and let in-flight
    // jobs finish (BullMQ re-queues any that don't drain in time as stalled), so
    // a deploy/restart doesn't hard-drop work mid-run.
    const shutdown = async (signal: string): Promise<void> => {
      console.log(`[worker] ${signal} received, closing workers...`);
      await Promise.allSettled(
        [
          workers.cellWorker,
          workers.runWorker,
          workers.judgeWorker,
          workers.onlineEvalWorker,
          workers.optimizeWorker,
          workers.emailWorker,
          workers.digestWorker,
          workers.retentionWorker,
        ].map((w) => w.close()),
      );
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  })().catch((err) => {
    console.error('[worker] failed to start workers', err);
    process.exit(1);
  });
}
