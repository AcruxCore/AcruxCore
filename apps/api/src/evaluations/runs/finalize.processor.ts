import type { FinalizeJobData } from '../queue';
import { RunsRepository } from './runs.repository';
import { NotFoundError } from '../../shared/errors';
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
async function notifyRunFinished(
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
 * @param data - The finalize job payload (`FinalizeJobData`, Task 2): teamId + runId.
 * @throws {NotFoundError} If the run cannot be found for this team.
 * @throws {Error} If fewer results than expected have been produced, or any
 *   produced result has not yet been judged. This is a deliberately retryable
 *   signal, not a terminal failure: the `finalize` Flow-parent job is created
 *   with `attempts`/`backoff` (see `runs.service.ts`'s `startRun`) precisely
 *   so BullMQ re-attempts this function until cell/judge jobs catch up,
 *   instead of the run finalizing prematurely while judging is still in flight.
 */
export async function processFinalize(data: FinalizeJobData): Promise<void> {
  const run = await runsRepo.getRunById(data.teamId, data.runId);
  if (!run) {
    throw new NotFoundError(`Experiment run ${data.runId} not found`);
  }

  const grid = run.grid as unknown[];
  const snapshot = run.exampleSnapshot as unknown[];
  const expectedCellCount = grid.length * snapshot.length;

  const results = await runsRepo.listResultsForRun(data.teamId, data.runId);
  const isJudged = (r: (typeof results)[number]): boolean =>
    r.errorMessage !== null || r.score !== null || r.reason !== null;

  if (results.length < expectedCellCount || !results.every(isJudged)) {
    throw new Error(`Run ${data.runId} not ready to finalize: cell/judge jobs still in flight`);
  }

  const everyCellErrored = results.length > 0 && results.every((r) => r.errorMessage !== null);
  const status = expectedCellCount > 0 && everyCellErrored ? 'failed' : 'succeeded';

  await runsRepo.setRunStatus(data.runId, status, { endedAt: new Date() });

  // After the status transition, so the email never describes a state that was
  // not persisted. `notify()` swallows its own failures, so this cannot turn a
  // finalized run back into a retryable job.
  await notifyRunFinished(data.runId, status);
}

/**
 * Transitions a run to a terminal `failed` status once its finalize job's
 * BullMQ retries are genuinely exhausted (all `attempts`/`backoff` — set in
 * `runs.service.ts`'s `startRun` — used up while `processFinalize` kept
 * throwing because cell/judge jobs never all settled in time: a moderate-size
 * run at low concurrency, a backed-up judge queue, or a permanent judge/
 * gateway outage can all trigger this).
 *
 * Called from `apps/worker`'s `runWorker.on('failed', ...)` handler
 * (`apps/worker/src/index.ts`), which owns the actual BullMQ bookkeeping
 * check (`job.attemptsMade >= job.opts.attempts`) — that check is pure BullMQ
 * job-shape logic with no domain meaning, so it stays in the worker's thin
 * wiring, mirroring `cellWorker`/`judgeWorker`'s existing `'failed'`
 * handlers. This function is the actual domain logic ("what happens when
 * finalize permanently gives up") and is kept here, in apps/api, so it stays
 * testable without needing apps/worker's compiled `dist/` output or a real
 * multi-minute BullMQ retry cycle.
 *
 * `setRunStatus`'s only other call site is `processFinalize`'s own success
 * path — without this function ever being invoked once retries are
 * exhausted, a run would stay at `queued` forever with no operator-visible
 * signal that anything went wrong.
 *
 * @param data - The exhausted finalize job's payload (teamId + runId).
 * @param failedReason - The BullMQ job's `failedReason` from its last
 *   attempt (i.e. the message from `processFinalize`'s last thrown `Error`),
 *   folded into the stored `error` message so an operator can see why.
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
