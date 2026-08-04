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
 * @param data - The judge job payload (`JudgeJobData`): teamId + the
 *   `eval_result` row id produced by `processCell`.
 * @returns Nothing. The verdict (or unscored placeholder) is persisted as a
 *   side effect via `JudgeService.scoreResult` -> `RunsRepository.writeVerdict`.
 * @throws Rethrows whatever `JudgeService.scoreResult` throws (e.g. a
 *   budget/rate-limit error from the gateway) unchanged, so BullMQ can record
 *   the job as failed and retry per its configured attempts — never swallowed
 *   here. `apps/worker`'s `judgeWorker` `'failed'` handler writes a terminal
 *   "judge call failed" marker onto the result once attempts are exhausted,
 *   so `finalize.processor`'s readiness check is never left waiting forever.
 */
export async function processJudge(data: JudgeJobData): Promise<void> {
  // Grade against the run's FROZEN criteria/overallFeedback/history (threaded
  // here by cell.processor from the run snapshot) rather than the live
  // mutable dataset, for reproducibility (FAQ Q5/Q19). Jobs enqueued before
  // these fields shipped carry none of these keys — pass `undefined` so
  // `scoreResult` falls back to a live read for them.
  const frozen =
    'criteria' in data || 'overallFeedback' in data || 'history' in data
      ? { criteria: data.criteria ?? null, overallFeedback: data.overallFeedback ?? null, history: data.history ?? null }
      : undefined;
  await judgeService.scoreResult(data.teamId, data.resultId, frozen);
}
