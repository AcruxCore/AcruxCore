import { randomUUID } from 'node:crypto';
import { RunsRepository } from '../runs/runs.repository';
import { GatewayService } from '../../gateway/completions/gateway.service';
import { GatewayRepository } from '../../gateway/completions/gateway.repository';
import { ConnectionsRepository } from '../../gateway/connections/connections.repository';
import type { GatewayCallContext } from '../../gateway/completions/completions.types';
import type { ChatMessage, ImageContentPart } from '../../gateway/providers/types';
import { compileEvaluatePrompt, renderJudgeTemplate } from './judge.prompt';
import { VersionsRepository } from '../../prompts/versions/versions.repository';
import { NunjucksRenderError, type MessageInput } from '../../prompts/versions/nunjucks.utils';
import { parseVerdict } from './judge.parse';

const runsRepo = new RunsRepository();
const versionsRepo = new VersionsRepository();
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
   * With the built-in judge, skips scoring (writes no numeric score, but
   * still writes a `reason` marker — see below) when the result has neither
   * per-example `criteria` nor a dataset-level `overallFeedback` — there is
   * nothing to grade against. A custom judge prompt always runs, since its
   * template can hold its own rubric. Otherwise compiles the judge prompt, calls the judge model
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
   * @param judgeModel - The team-registered `GatewayModel.publicName` that
   *   grades this result. Always the caller's choice (`judge_model` on the
   *   experiment or optimize request): the server has no default, in code or
   *   in the environment.
   * @param frozen - The grading inputs FROZEN at run-start (per-example
   *   `criteria` + dataset-level `overallFeedback`, plus the example's
   *   `history` — FAQ Q19), threaded from the run snapshot via the judge job.
   *   When provided, the judge grades against these — so editing the dataset
   *   after (or during) a run cannot change what a result was scored against
   *   (FAQ Q5 reproducibility). Omitted only by legacy callers / pre-existing
   *   jobs, which fall back to reading the result's live
   *   `criteria`/`overallFeedback`/`history`. `images` carries the image(s) the model saw, so the
   *   judge model must be able to read images when an example has one (`judgeModel`).
   * @param judgePromptVersionId - The custom judge prompt version the run froze
   *   at start (issue #578), or absent for the built-in judge. Looked up within
   *   `teamId`. If it is not found or its template fails to render, the result
   *   is written unscored with a `judge prompt error: …` reason and no model is
   *   called. Any other error loading it is rethrown, so BullMQ retries.
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
    judgeModel: string,
    frozen?: {
      criteria: string | null;
      overallFeedback: string | null;
      history?: ChatMessage[] | null;
      /** The image(s) the model under test was shown, for a vision judge (issue #573). */
      images?: ImageContentPart[] | null;
    },
    judgePromptVersionId?: string | null,
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
    const verdict = await this.grade(
      teamId,
      judgeModel,
      { output: result.output, criteria, overallFeedback, history, images: frozen?.images ?? null },
      judgePromptVersionId,
    );
    await runsRepo.writeVerdict(resultId, verdict);
  }

  /**
   * Grades one output and returns the verdict without storing it — the shared
   * core of {@link scoreResult} (a server-side run's result) and of the judge
   * call a local run's SDK makes for its own outputs (phase-5 FAQ Q59).
   *
   * Always returns *something*: a numeric verdict, or a null score with a
   * `reason` saying why there is none (no rubric to grade against, a judge
   * prompt that is missing or fails to render, or two unparseable replies).
   *
   * @param teamId - Isolation boundary; the judge call is billed to this team.
   * @param judgeModel - A model registered under Gateway → Models.
   * @param input - The output to grade and what to grade it against.
   * @param judgePromptVersionId - A custom judge prompt version, or absent for the built-in judge.
   * @returns Score 0–100 (or null), pass/fail, reason, and the judge call's trace id.
   * @throws Rethrows gateway errors (budget, rate limit, provider failure) unchanged.
   */
  async grade(
    teamId: string,
    judgeModel: string,
    input: {
      output: unknown;
      criteria: string | null;
      overallFeedback: string | null;
      history: ChatMessage[] | null;
      images?: ImageContentPart[] | null;
    },
    judgePromptVersionId?: string | null,
  ): Promise<JudgeVerdict> {
    const gradingInput = { ...input, images: input.images ?? null };

    let messages: ChatMessage[];
    if (judgePromptVersionId) {
      // A team's own judge template (issue #578). It always runs, even with no
      // criteria: the template can hold its own rubric (phase-5 FAQ Q43).
      const version = await versionsRepo.findByIdForTeam(judgePromptVersionId, teamId);
      // A missing version or a template that fails to render fails every
      // retry the same way, so record why the result is unscored and stop,
      // without calling a model. Any other error (a database error, say) is
      // rethrown so BullMQ retries it.
      const rendered = version
        ? await renderJudgeTemplate(version.messages as unknown as MessageInput[], gradingInput).catch((err: unknown) => {
            if (err instanceof NunjucksRenderError) return err.message;
            throw err;
          })
        : 'the judge prompt version was not found.';
      if (typeof rendered === 'string') {
        return { score: null, passed: null, reason: `judge prompt error: ${rendered}`, judgeTraceId: null };
      }
      messages = rendered;
    } else {
      if (gradingInput.criteria === null && gradingInput.overallFeedback === null) {
        // The built-in judge has no rubric of its own, so there is nothing to
        // grade against. Still return a marker (score/passed stay null; only
        // `reason` is set) so finalize.processor's readiness check can
        // distinguish "judged, intentionally not scored" from "judge job
        // hasn't run yet" — see scoreResult's docstring.
        return {
          score: null,
          passed: null,
          reason: 'not judged: no criteria or overall feedback to grade against',
          judgeTraceId: null,
        };
      }
      messages = compileEvaluatePrompt(gradingInput);
    }

    const attempt = async (): Promise<{ verdict: ReturnType<typeof parseVerdict>; traceId: string }> => {
      // Minted up front, same reasoning as cell.processor.ts: GatewayResult
      // does not carry the trace id it produced, but a caller-supplied
      // ctx.traceId becomes the new trace's row PK when no trace with that id
      // exists yet, so generating it here is sufficient to know the resulting
      // trace id without a lookup.
      const traceId = randomUUID();
      const ctx: GatewayCallContext = { teamId, traceId };
      const gatewayResult = await gateway.complete(ctx, { model: judgeModel, messages, temperature: 0 });
      const assistantContent = gatewayResult.body.choices[0]?.message.content ?? '';
      return { verdict: parseVerdict(assistantContent), traceId };
    };

    const first = await attempt();
    if (first.verdict) return { ...first.verdict, judgeTraceId: first.traceId };

    // Retry once with a fresh call before giving up.
    const retry = await attempt();
    if (retry.verdict) return { ...retry.verdict, judgeTraceId: retry.traceId };

    return { score: null, passed: null, reason: 'judge parse error', judgeTraceId: retry.traceId };
  }
}

/** What {@link JudgeService.grade} decided about one output. */
export interface JudgeVerdict {
  /** 0–100, or null when the output was not graded (see `reason`). */
  score: number | null;
  passed: boolean | null;
  reason: string | null;
  /** The judge call's trace, or null when no model was called. */
  judgeTraceId: string | null;
}
