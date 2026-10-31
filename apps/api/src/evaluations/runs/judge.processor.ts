import { UnrecoverableError } from 'bullmq';
import { ProviderPermanentError } from '../../shared/errors';
import type { JudgeJobData } from '../queue';
import { JudgeService } from '../judge/judge.service';

const judgeService = new JudgeService();

/**
 * Executes one judge scoring job: grades a produced `eval_result` row via
 * `JudgeService.scoreResult`, which compiles the evaluate prompt, calls the
 * judge model through the gateway (in-process, same budgets/rate-limits/cost
 * ledger as any other gateway caller), and persists the verdict (or an
 * unscored placeholder) back onto the row.
 *
 * A thin wrapper only, by design: all judging logic lives in `JudgeService` so
 * both the queue-driven path (this function, used by `apps/worker`'s
 * `judgeWorker`) and any future direct/synchronous caller share one
 * implementation, mirroring how `processCell`/`processFinalize` wrap
 * `GatewayService`/`RunsRepository` calls rather than re-implement them.
 *
 * @param data - The judge job payload (`JudgeJobData`): teamId, the
 *   `eval_result` row id produced by `processCell`, and the `judgeModel` the
 *   run's caller chose.
 * @returns Nothing. The verdict (or unscored placeholder) is persisted as a
 *   side effect via `JudgeService.scoreResult` -> `RunsRepository.writeVerdict`.
 * @throws Rethrows whatever `JudgeService.scoreResult` throws (e.g. a
 *   budget/rate-limit error from the gateway) unchanged, so BullMQ can record
 *   the job as failed and retry per its configured attempts — never swallowed
 *   here. `apps/worker`'s `judgeWorker` `'failed'` handler writes a terminal
 *   "judge call failed" marker onto the result once attempts are exhausted,
 *   so `finalize.processor`'s readiness check is never left waiting forever.
 * @throws {UnrecoverableError} If the job names no judge model (queued before
 *   judges were chosen per run), or the gateway answered a `ProviderPermanentError`
 *   (409). BullMQ does not retry it.
 */
export async function processJudge(data: JudgeJobData): Promise<void> {
  // No default judge exists, in code or in the environment. A job without a
  // model was queued before judges were chosen per run; fail it loudly (the
  // worker's `'failed'` handler then writes the terminal "judge call failed"
  // marker) rather than grade with a model the caller never picked. It is
  // unrecoverable: a retry would fail the same way, and only delay the run.
  if (!data.judgeModel) {
    throw new UnrecoverableError(
      `Result ${data.resultId} has no judge model: the run was queued before judges were chosen per experiment. Start a new run.`,
    );
  }
  // Grade against the run's FROZEN criteria/overallFeedback/history (threaded
  // here by cell.processor from the run snapshot) rather than the live
  // mutable dataset, for reproducibility (FAQ Q5/Q19). Jobs enqueued before
  // these fields shipped carry none of these keys — pass `undefined` so
  // `scoreResult` falls back to a live read for them.
  const frozen =
    'criteria' in data || 'overallFeedback' in data || 'history' in data
      ? {
          criteria: data.criteria ?? null,
          overallFeedback: data.overallFeedback ?? null,
          history: data.history ?? null,
          images: data.images ?? null,
        }
      : undefined;
  try {
    await judgeService.scoreResult(data.teamId, data.resultId, data.judgeModel, frozen, data.judgePromptVersionId);
  } catch (err) {
    // A judge model whose key is refused fails the same way on every retry, and each retry
    // was one more gateway row and red trace (issue #737). Terminal on the first attempt.
    if (err instanceof ProviderPermanentError) throw new UnrecoverableError(err.message);
    throw err;
  }
}
