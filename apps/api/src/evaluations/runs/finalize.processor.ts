import { DelayedError, type Job } from 'bullmq';
import { hasUnsettledJudgeJob, type FinalizeJobData } from '../queue';
import { RunsRepository } from './runs.repository';
import { NotFoundError, RunNotReadyError } from '../../shared/errors';
// Imported from the concrete file, not the `../../notifications` barrel: that
// barrel re-exports `notificationsRouter`, which pulls in Express as a load-time
// side effect. This processor is part of apps/worker's dependency graph, which is
// deliberately Express-free (see `gateway.service.ts`'s import comments).
import { notify } from '../../notifications/notify';
import { appLink } from '../../email';

const runsRepo = new RunsRepository();

/**
 * Enqueues the run-finished notification for a run that has just reached a
 * terminal state.
 *
 * Recipients, in order of preference: whoever started the run, then whoever
 * created the experiment, then the team's owners. A run started by a team-scoped
 * API key has no acting user, and every run created before `created_by` existed
 * has none either — the fallback chain is what stops those from notifying nobody.
 *
 * Both outcomes notify. A failed run is *more* interesting than a successful one,
 * not less.
 *
 * The dedupe key is `run:<runId>` with no time component: the finalize job
 * legitimately retries many times while it waits on judge jobs, and each retry
 * that finally succeeds would otherwise mail the same result again.
 *
 * @param runId - The run that just settled.
 * @param outcome - The terminal status it settled to.
 */
export async function notifyRunFinished(
  runId: string,
  outcome: 'succeeded' | 'failed',
): Promise<void> {
  const ctx = await runsRepo.getRunNotificationContext(runId);
  if (!ctx) return;

  const starter = ctx.createdBy ?? ctx.experimentCreatedBy;
  const durationSeconds =
    ctx.startedAt && ctx.endedAt
      ? (ctx.endedAt.getTime() - ctx.startedAt.getTime()) / 1000
      : null;

  await notify({
    teamId: ctx.teamId,
    category: 'eval_runs',
    audience: {
      userIds: starter ? [starter] : [],
      fallbackRoles: ['owner'],
    },
    dedupeKey: `run:${runId}`,
    payload: {
      type: 'eval_run_finished',
      props: {
        teamName: ctx.teamName,
        experimentName: ctx.experimentName ?? 'Untitled experiment',
        outcome,
        succeededCells: ctx.succeededCells,
        erroredCells: ctx.erroredCells,
        durationSeconds,
        runUrl: appLink(`/evaluations/runs/${runId}`),
      },
    },
  });
}

/**
 * Finalizes a run once every one of its cell jobs has settled (BullMQ Flow
 * guarantees this parent job only runs after all children complete) AND every
 * produced result has also been judged (Task 4): compares the produced
 * `eval_result` rows against the expected `grid × exampleSnapshot` cell count,
 * then marks the run `failed` only when every produced result is an error,
 * otherwise `succeeded` — then stamps `endedAt`.
 *
 * Per-cell judge jobs are enqueued independently from `cell.processor` right
 * after `writeResult` (Task 4) — they are NOT modeled as BullMQ Flow children
 * of this job, so this parent can become eligible to run (all cell children
 * settled) before every cell's judge job has actually finished. A produced
 * `eval_result` row counts as "judged" once it carries any of: a non-null
 * `errorMessage` (the cell itself failed — nothing to judge), a non-null
 * `score` (the judge graded it), or a non-null `reason` (the judge ran and
 * either gave up after one parse-error retry, or intentionally chose not to
 * grade because neither per-example `criteria` nor the dataset's
 * `overallFeedback` were set). `JudgeService.scoreResult` writes a `reason`
 * marker on that last, "nothing to grade against" path specifically so it can
 * be told apart here from "judge job hasn't run yet" (see its own docstring)
 * — a result with `errorMessage`/`score`/`reason` all null has simply not
 * been judged yet.
 *
 * Readiness is checked with one aggregate count, not by loading the results: this
 * runs every few seconds for as long as judging lasts. Only a run whose every cell
 * errored reads its rows, and then only their error messages.
 *
 * @param data - The finalize job payload (`FinalizeJobData`, Task 2): teamId + runId.
 * @throws {NotFoundError} If the run cannot be found for this team.
 * @throws {RunNotReadyError} If fewer results than expected have been produced, or
 *   any produced result has not yet been judged. Not a failure: `processFinalizeJob`
 *   catches it and polls again later without using an attempt.
 */
export async function processFinalize(data: FinalizeJobData): Promise<void> {
  const run = await runsRepo.getRunById(data.teamId, data.runId);
  if (!run) {
    throw new NotFoundError(`Experiment run ${data.runId} not found`);
  }

  const grid = run.grid as unknown[];
  const snapshot = run.exampleSnapshot as unknown[];
  const expectedCellCount = grid.length * snapshot.length;

  const { produced, judged, errored } = await runsRepo.countResultProgress(data.teamId, data.runId);
  if (produced < expectedCellCount || judged < produced) {
    throw new RunNotReadyError(data.runId, produced, judged, expectedCellCount);
  }

  const everyCellErrored = produced > 0 && errored === produced;
  const status = expectedCellCount > 0 && everyCellErrored ? 'failed' : 'succeeded';

  await runsRepo.setRunStatus(data.runId, status, {
    endedAt: new Date(),
    // A run that failed because every cell failed used to be stored with a null
    // `error`, so `GET /runs/:id` answered "failed" and said nothing else — the
    // reason existed only on the individual `eval_results` rows (issue #504).
    ...(status === 'failed'
      ? { error: summariseCellErrors(await runsRepo.listResultErrorsForRun(data.teamId, data.runId)) }
      : {}),
  });

  // After the status transition, so the email never describes a state that was
  // not persisted. `notify()` swallows its own failures, so this cannot turn a
  // finalized run back into a retryable job.
  await notifyRunFinished(data.runId, status);
}

/**
 * The shortest stretch with no progress at all after which a run is failed. One
 * judge call through a reasoning model, with the gateway's own retries on a 429,
 * can take minutes; a run must not fail while that one call is still in flight.
 */
export const FINALIZE_MIN_STALL_MS = 5 * 60_000;

/**
 * The longest a run waits with no progress while one of its judge jobs is still queued
 * or running. A healthy judge job ends well inside this: 3 attempts, 2 gateway calls each,
 * each allowed `GATEWAY_TIMEOUT_MS` (60 s), is about 6 minutes plus backoff. Without a
 * limit, a judge call that hangs while its worker keeps renewing the lock, or a paused
 * judge queue, kept the run `running` until the stale-run reaper (2 hours).
 */
export const FINALIZE_MAX_JUDGE_WAIT_MS = 30 * 60_000;

/**
 * The finalize worker's processor: finalizes the run, or waits while it is still
 * making progress, and fails it only once it has stopped.
 *
 * The finalize job used to count every "not ready yet" poll as a failed attempt,
 * so a run had a fixed time budget (attempts × backoff delay, about 3.5 minutes
 * for 60 answers) measured from when its last *cell* finished. Judging is slower
 * than producing answers — judge workers run 2 calls at a time, and a reasoning
 * judge takes several seconds per call — so a healthy run whose verdicts were
 * still arriving was marked `failed`, and its last verdicts landed after the
 * report had been read.
 *
 * Now a not-ready poll moves the job back to delayed without using an attempt,
 * remembering in the job data how many answers were produced plus judged. The
 * run is failed only when that number has not moved for the stall window: the
 * same attempts × delay the job was sized with, and never less than
 * {@link FINALIZE_MIN_STALL_MS}. While a judge job for one of the run's unjudged
 * results is still queued, running or waiting to retry, the run keeps waiting
 * (issue #591), but for no longer than {@link FINALIZE_MAX_JUDGE_WAIT_MS} with no
 * progress. Any other error (a database failure, say) still uses the job's normal
 * attempts and the worker's `'failed'` handler.
 *
 * @param job - The finalize job. Its `opts.attempts` and `opts.backoff.delay`
 *   size the poll interval and the stall window.
 * @param token - The worker's lock token, required by `moveToDelayed`.
 * @param opts - `minStallMs` overrides {@link FINALIZE_MIN_STALL_MS} and `maxJudgeWaitMs`
 *   overrides {@link FINALIZE_MAX_JUDGE_WAIT_MS} (tests only).
 * @returns Nothing once the run is finalized or failed as stalled.
 * @throws {DelayedError} While the run is still progressing — BullMQ's signal that
 *   the job was moved back to delayed, not failed.
 */
export async function processFinalizeJob(
  job: Job<FinalizeJobData>,
  token?: string,
  opts: { minStallMs?: number; maxJudgeWaitMs?: number } = {},
): Promise<void> {
  try {
    await processFinalize(job.data);
    return;
  } catch (err) {
    if (!(err instanceof RunNotReadyError)) throw err;
    const now = Date.now();
    const count = err.produced + err.judged;
    const last = job.data.progress;
    const changedAt = !last || count > last.count ? now : last.changedAt;

    const backoff = job.opts.backoff;
    const pollMs = typeof backoff === 'object' && backoff.delay ? backoff.delay : 3000;
    const stallMs = Math.max((job.opts.attempts ?? 20) * pollMs, opts.minStallMs ?? FINALIZE_MIN_STALL_MS);
    // One judge job can outlast the stall window without being stuck: 3 attempts with
    // backoff, up to 2 gateway calls each, each allowed GATEWAY_TIMEOUT_MS, plus any
    // wait behind other teams' runs. While a job for one of this run's unjudged
    // results is still queued, running or retrying, the run is waiting, not stalled
    // (issue #591). `changedAt` is left alone, so the wait is measured from the last
    // real progress and is cut off at maxJudgeWaitMs.
    const stalledFor = now - changedAt;
    if (stalledFor > stallMs) {
      const judgePending = await hasUnsettledJudgeJob(
        await runsRepo.listUnjudgedResultIds(job.data.teamId, job.data.runId),
      );
      if (!judgePending || stalledFor > (opts.maxJudgeWaitMs ?? FINALIZE_MAX_JUDGE_WAIT_MS)) {
        const minutes = Math.round(stalledFor / 6000) / 10;
        await markFinalizeExhausted(
          job.data,
          `no progress for ${minutes} min (${err.judged} of ${err.expected} results judged, ` +
            `${err.produced} of ${err.expected} produced)` +
            (judgePending ? '; a judge job is still queued or running' : ''),
        );
        return;
      }
    }

    await job.updateData({ ...job.data, progress: { count, changedAt } });
    await job.moveToDelayed(now + pollMs, token);
    throw new DelayedError();
  }
}

/**
 * Transitions a run to a terminal `failed` status once finalize gives up on it.
 *
 * Two callers, for two reasons:
 * - `processFinalizeJob`, when the run has made no progress (no new answer, no
 *   new verdict, and no judge job of its own still queued or retrying) for the
 *   whole stall window — in practice, a lost judge job. `failedReason` says how
 *   long and how far it got.
 * - `apps/worker`'s `runWorker.on('failed', ...)` handler, when the finalize job
 *   used up its attempts on real errors (a database failure, say). That handler
 *   owns the BullMQ check `job.attemptsMade >= job.opts.attempts`, which is job
 *   bookkeeping with no domain meaning; this function is the domain step, kept
 *   here in apps/api so it is testable without apps/worker's compiled `dist/`.
 *
 * Without it, a run that finalize abandoned would stay unfinished until the stale
 * run reaper, with nothing on the run to say why.
 *
 * @param data - The finalize job's payload (teamId + runId).
 * @param failedReason - Why finalize gave up, folded into the stored `error`
 *   message so an operator can see it.
 */
export async function markFinalizeExhausted(data: FinalizeJobData, failedReason: string | undefined): Promise<void> {
  await runsRepo.setRunStatus(data.runId, 'failed', {
    endedAt: new Date(),
    error: `finalize timed out waiting for cell/judge jobs to complete: ${failedReason ?? 'unknown error'}`,
  });

  // This is a terminal transition too, and the one a user is most likely to be
  // still waiting on — a run that gave up after exhausting its retries is
  // exactly the case where nobody is watching the tab any more. Same
  // `run:<runId>` dedupe key as the success path, so a run cannot be reported
  // twice if both paths somehow fire.
  await notifyRunFinished(data.runId, 'failed');
}

/**
 * Condenses an all-cells-failed run into one line for `experiment_runs.error`.
 *
 * Every cell failing for the same reason is the common case — an unregistered
 * model, an exhausted budget, a revoked credential — and repeating it once per
 * cell would tell the reader nothing extra. When the reasons genuinely differ,
 * naming the first is honest about there being more, and the per-cell messages
 * are one click away in the cell drill-down.
 *
 * @param results - The run's `eval_results` rows, every one of which carries a
 *   non-null `errorMessage` (the caller has already established that).
 * @returns A single sentence for the run row.
 */
function summariseCellErrors(results: Array<{ errorMessage: string | null }>): string {
  const messages = results.map((r) => r.errorMessage).filter((m): m is string => m !== null);
  if (messages.length === 0) return 'Every cell failed.';
  const distinct = new Set(messages);
  return distinct.size === 1
    ? `Every cell failed. ${messages[0]}`
    : `Every cell failed. First error: ${messages[0]}`;
}
