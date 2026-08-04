import { randomUUID } from 'node:crypto';
import { RunsRepository } from '../runs/runs.repository';
import { GatewayService } from '../../gateway/completions/gateway.service';
import { GatewayRepository } from '../../gateway/completions/gateway.repository';
import { ConnectionsRepository } from '../../gateway/connections/connections.repository';
import type { GatewayCallContext } from '../../gateway/completions/completions.types';
import type { ChatMessage } from '../../gateway/providers/types';
import { compileEvaluatePrompt } from './judge.prompt';
import { parseVerdict } from './judge.parse';

/**
 * The LLM-as-judge model, overridable per deployment. `gpt-4o-mini` mirrors
 * the model used throughout this repo's eval-engine tests/fixtures (E3) —
 * capable enough to grade semantically, cheap enough to run on every result.
 */
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? 'gpt-4o-mini';

const runsRepo = new RunsRepository();
// Same construction as cell.processor.ts's module-level instance — the judge
// call goes through the identical DI wiring (budgets/cache/cost ledger) as
// any other in-process gateway caller, so it is never a bypass of team spend
// caps or rate limits.
const gateway = new GatewayService(new GatewayRepository(), new ConnectionsRepository());

/**
 * LLM-as-judge scoring: reads a produced `eval_result`, asks the judge model
 * (via the gateway, in-process — same budgets/rate-limits/cost-ledger path as
 * live traffic) to grade the output against the example's criteria and/or the
 * dataset's overall feedback, and persists the verdict back onto the row.
 */
export class JudgeService {
  /**
   * Scores one `eval_result` row, in place.
   *
   * Skips scoring (writes no numeric score, but still writes a `reason`
   * marker — see below) when the result has neither per-example `criteria`
   * nor a dataset-level `overallFeedback` — there is nothing to grade
   * against. Otherwise compiles the evaluate prompt, calls the judge model
   * once, and retries exactly once on a parse failure before giving up and
   * recording an unscored placeholder with a `judge parse error` reason.
   *
   * Every code path through this method — scored, parse-failure-unscored, or
   * "nothing to grade against"-unscored — writes *something* onto the row via
   * `writeVerdict`: either a non-null `score`, or a non-null `reason`
   * explaining why there isn't one. This is deliberate: `finalize.processor`
   * (Task 4) needs to tell "this result has not been judged yet" apart from
   * "the judge ran and intentionally left it unscored", and both would
   * otherwise look identical (`score`/`reason`/`judgeTraceId` all null).
   *
   * @param teamId - Isolation boundary; the result must belong to this team.
   * @param resultId - The `eval_result` row to score.
   * @param frozen - The grading inputs FROZEN at run-start (per-example
   *   `criteria` + dataset-level `overallFeedback`, plus the example's
   *   `history` — FAQ Q19), threaded from the run snapshot via the judge job.
   *   When provided, the judge grades against these — so editing the dataset
   *   after (or during) a run cannot change what a result was scored against
   *   (FAQ Q5 reproducibility). Omitted only by legacy callers / pre-existing
   *   jobs, which fall back to reading the result's live
   *   `criteria`/`overallFeedback`/`history`.
   * @returns Nothing. The verdict (or the unscored placeholder) is persisted
   *   as a side effect via `RunsRepository.writeVerdict`.
   * @throws {NotFoundError} Never thrown directly — a missing/cross-team
   *   result id is instead silently a no-op (mirrors `getResultById`
   *   returning null); callers that need existence guarantees should check
   *   before calling.
   * @throws Rethrows whatever `GatewayService.complete` throws (e.g.
   *   `PaymentRequiredError` 402 BUDGET_EXCEEDED, `RateLimitedError` 429) —
   *   the judge call is never allowed to bypass budgets/rate limits, so a
   *   capped team fails the judge call exactly like it would fail live
   *   traffic, and this method does not swallow that failure.
   */
  async scoreResult(
    teamId: string,
    resultId: string,
    frozen?: { criteria: string | null; overallFeedback: string | null; history?: ChatMessage[] | null },
  ): Promise<void> {
    const result = await runsRepo.getResultById(teamId, resultId);
    if (!result) {
      return;
    }

    // Prefer the run's frozen grading inputs; fall back to the live dataset
    // values only for legacy callers/jobs that don't carry them (see @param).
    const criteria = frozen ? frozen.criteria : result.example.criteria;
    const overallFeedback = frozen ? frozen.overallFeedback : result.example.dataset.overallFeedback;
    const history = frozen ? frozen.history ?? null : (result.example.history as unknown as ChatMessage[] | null);
    if (criteria === null && overallFeedback === null) {
      // Nothing to grade against. Still write a marker (score/passed stay
      // null; only `reason` is set) so finalize.processor's readiness check
      // can distinguish "judged, intentionally not scored" from "judge job
      // hasn't run yet" — see this method's own docstring.
      await runsRepo.writeVerdict(resultId, {
        score: null,
        passed: null,
        reason: 'not judged: no criteria or overall feedback to grade against',
        judgeTraceId: null,
      });
      return;
    }

    const messages = compileEvaluatePrompt({ output: result.output, criteria, overallFeedback, history });

    const attempt = async (): Promise<{ verdict: ReturnType<typeof parseVerdict>; traceId: string }> => {
      // Minted up front, same reasoning as cell.processor.ts: GatewayResult
      // does not carry the trace id it produced, but a caller-supplied
      // ctx.traceId becomes the new trace's row PK when no trace with that id
      // exists yet, so generating it here is sufficient to know the resulting
      // trace id without a lookup.
      const traceId = randomUUID();
      const ctx: GatewayCallContext = { teamId, traceId };
      const gatewayResult = await gateway.complete(ctx, { model: JUDGE_MODEL, messages, temperature: 0, max_tokens: 300 });
      const assistantContent = gatewayResult.body.choices[0]?.message.content ?? '';
      return { verdict: parseVerdict(assistantContent), traceId };
    };

    const first = await attempt();
    if (first.verdict) {
      await runsRepo.writeVerdict(resultId, { ...first.verdict, judgeTraceId: first.traceId });
      return;
    }

    // Retry once with a fresh call before giving up.
    const retry = await attempt();
    if (retry.verdict) {
      await runsRepo.writeVerdict(resultId, { ...retry.verdict, judgeTraceId: retry.traceId });
      return;
    }

    await runsRepo.writeVerdict(resultId, {
      score: null,
      passed: null,
      reason: 'judge parse error',
      judgeTraceId: retry.traceId,
    });
  }
}
