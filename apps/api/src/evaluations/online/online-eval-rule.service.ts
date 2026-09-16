import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { GatewayService } from '../../gateway/completions/gateway.service';
import { GatewayRepository } from '../../gateway/completions/gateway.repository';
import { ConnectionsRepository } from '../../gateway/connections/connections.repository';
import { ModelsRepository } from '../../gateway/models/models.repository';
import { PromptsRepository } from '../../prompts/prompts.repository';
import { compileEvaluatePrompt, compileCustomJudgePrompt } from '../judge/judge.prompt';
import { parseVerdict } from '../judge/judge.parse';
import { DatasetsRepository } from '../datasets/datasets.repository';
import prisma from '../../shared/db/client';
import { audit } from '../../shared/audit';
import { EvalRuleRepository } from './online-eval-rule.repository';
import { matchesFilter } from './eval-rule-matcher';
import { judgeableOutput } from './span-output';
import type {
  CreateEvalRuleDto,
  UpdateEvalRuleDto,
  EvalRuleResponse,
  RuleScoreListQuery,
  ToDatasetDto,
  PreviewVerdict,
  EvalRuleFilter,
} from './online-eval-rule.types';

const gateway = new GatewayService(new GatewayRepository(), new ConnectionsRepository());
const datasetsRepo = new DatasetsRepository();
const modelsRepo = new ModelsRepository();
const promptsRepo = new PromptsRepository();
/** Marks a judge's own gateway call so no rule ever scores it. Exported so the worker processor (Task 9) can check for the exact same marker rather than keeping a second, driftable copy. */
export const JUDGE_MARKER = 'acx.online_eval.judge';

/** Maps a Prisma `EvalRule` row plus optional today's-stats into the API response shape. */
function toResponse(
  rule: Awaited<ReturnType<EvalRuleRepository['create']>>,
  stats: { count: number; meanScore: number | null } = { count: 0, meanScore: null },
): EvalRuleResponse {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    kind: 'llm_judge',
    criteria: rule.criteria,
    judgeModel: rule.judgeModel,
    judgePromptId: rule.judgePromptId,
    sampleRate: rule.sampleRate.toNumber(),
    dailyLimit: rule.dailyLimit,
    alertBelow: rule.alertBelow,
    filter: rule.filter as EvalRuleResponse['filter'],
    createdBy: rule.createdBy,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
    todayCount: stats.count,
    todayMeanScore: stats.meanScore,
  };
}

/** Business logic for the online-eval-rule domain: validation, DTO shaping, and the preview/to-dataset flows that share code with the worker. */
export class OnlineEvalRuleService {
  constructor(private readonly repo: EvalRuleRepository) {}

  /**
   * Creates a new online-eval rule for a team.
   *
   * @param teamId - Isolation boundary.
   * @param userId - The creating user, stamped as `createdBy`.
   * @param input - Validated rule fields (name, criteria, filter, sampling, limits).
   * @returns The created rule, shaped for the API response.
   * @throws {ValidationError} If `judgeModel` doesn't resolve to a model registered
   *   for this team, or `judgePromptId` doesn't resolve to a prompt in this team.
   */
  async createRule(teamId: string, userId: string, input: CreateEvalRuleDto): Promise<EvalRuleResponse> {
    await this.assertJudgeModelExists(teamId, input.judgeModel);
    await this.assertJudgePromptExists(teamId, input.judgePromptId);
    const rule = await this.repo.create(teamId, userId, input);
    await audit(prisma, {
      teamId,
      actorId: userId,
      event: 'eval_rule_created',
      metadata: { ruleId: rule.id, name: rule.name, judgeModel: rule.judgeModel, enabled: rule.enabled },
    });
    return toResponse(rule);
  }

  /**
   * Validates that `publicName` is a model registered for this team — the
   * online-eval-rule redesign (phase-5-faq) removed the hardcoded
   * `EVAL_JUDGE_MODEL` fallback, so every rule's judge model must be real.
   *
   * @throws {ValidationError} If no such model exists for the team.
   */
  private async assertJudgeModelExists(teamId: string, publicName: string): Promise<void> {
    const model = await modelsRepo.findByPublicName(teamId, publicName);
    if (!model) {
      throw new ValidationError(`Model '${publicName}' is not registered. Add it under Gateway → Models.`);
    }
  }

  /**
   * Validates that `judgePromptId`, when provided, is a prompt belonging to
   * this team. A no-op for `null`/`undefined` (built-in judge).
   *
   * @throws {ValidationError} If the prompt doesn't exist in this team.
   */
  private async assertJudgePromptExists(teamId: string, judgePromptId: string | null | undefined): Promise<void> {
    if (!judgePromptId) return;
    const prompt = await promptsRepo.findById(judgePromptId, teamId);
    if (!prompt) {
      throw new ValidationError('judgePromptId does not refer to a prompt in this team.');
    }
  }

  /**
   * Lists every rule for a team with today's (UTC) aggregate stats attached.
   *
   * @param teamId - Isolation boundary.
   * @returns All rules for the team, newest first.
   */
  async listRules(teamId: string): Promise<EvalRuleResponse[]> {
    const rules = await this.repo.list(teamId);
    const stats = await this.repo.getTodayStats(rules.map((r) => r.id), teamId);
    return rules.map((r) => toResponse(r, stats.get(r.id)));
  }

  /** @throws {NotFoundError} when the rule doesn't exist or belongs to another team. */
  async getRule(id: string, teamId: string): Promise<EvalRuleResponse> {
    const rule = await this.repo.findById(id, teamId);
    if (!rule) throw new NotFoundError('Rule not found.');
    const stats = await this.repo.getTodayStats([id], teamId);
    return toResponse(rule, stats.get(id));
  }

  /**
   * @throws {NotFoundError} same as `getRule`.
   * @throws {ValidationError} same as `createRule`, when the patch touches
   *   `judgeModel`/`judgePromptId`.
   */
  async updateRule(
    id: string,
    teamId: string,
    actorId: string,
    patch: UpdateEvalRuleDto,
  ): Promise<EvalRuleResponse> {
    if (patch.judgeModel !== undefined) await this.assertJudgeModelExists(teamId, patch.judgeModel);
    if (patch.judgePromptId !== undefined) await this.assertJudgePromptExists(teamId, patch.judgePromptId);
    const rule = await this.repo.update(id, teamId, patch);
    if (!rule) throw new NotFoundError('Rule not found.');
    // Field names, not values: `criteria` and a custom judge prompt are free text
    // that can run to thousands of characters, and the trail is a record of who
    // acted, not a second copy of the rule. `enabled` is the exception, because
    // it is the field that starts and stops the spend.
    await audit(prisma, {
      teamId,
      actorId,
      event: 'eval_rule_updated',
      metadata: {
        ruleId: rule.id,
        name: rule.name,
        changed: Object.keys(patch),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      },
    });
    return toResponse(rule);
  }

  /** @throws {NotFoundError} same as `getRule`. */
  async deleteRule(id: string, teamId: string, actorId: string): Promise<void> {
    const removed = await this.repo.remove(id, teamId);
    if (!removed) throw new NotFoundError('Rule not found.');
    // Deleting a rule cascades its scores away, so this row is the only thing left
    // that says the rule existed and who removed it.
    await audit(prisma, {
      teamId,
      actorId,
      event: 'eval_rule_deleted',
      metadata: { ruleId: id, name: removed.name },
    });
  }

  /** @throws {NotFoundError} same as `getRule`. */
  async listScores(id: string, teamId: string, filters: RuleScoreListQuery) {
    const rule = await this.repo.findById(id, teamId);
    if (!rule) throw new NotFoundError('Rule not found.');
    return this.repo.listScores(id, teamId, filters);
  }

  /**
   * Dry run: judges the last N matching `llm` spans without persisting a
   * score row. Shares `matchesFilter` with the worker so a preview can never
   * disagree with what the live rule would actually score.
   *
   * @throws {NotFoundError} same as `getRule`.
   */
  async previewRule(id: string, teamId: string, limit: number): Promise<PreviewVerdict[]> {
    const rule = await this.repo.findById(id, teamId);
    if (!rule) throw new NotFoundError('Rule not found.');

    const candidateSpans = await prisma.span.findMany({
      where: { teamId, kind: 'llm' },
      orderBy: { createdAt: 'desc' },
      take: 200, // scan window; matched down to `limit` below
      include: { trace: { select: { sessionId: true } }, payload: true },
    });

    const filter = rule.filter as EvalRuleFilter;
    const verdicts: PreviewVerdict[] = [];
    for (const span of candidateSpans) {
      if (verdicts.length >= limit) break;
      const isMatch = await matchesFilter(filter, {
        promptVersionId: span.promptVersionId,
        model: span.model,
        tags: span.tags,
        sessionId: span.trace?.sessionId ?? null,
      });
      if (!isMatch) continue;
      // Explicitly absent, not merely falsy — the same test `online-eval.processor.ts`
      // applies. A truthiness check reported a present-but-empty output as "capture is
      // off" here while the worker went ahead and judged it, which is exactly the
      // disagreement the note below promises there isn't.
      const previewOutput = span.payload?.output;
      if (previewOutput === undefined || previewOutput === null) {
        verdicts.push({ spanId: span.id, traceId: span.traceId, score: null, passed: null, reason: 'not scored: payload capture is off for this team' });
        continue;
      }
      const verdict = await this.judge(
        teamId,
        rule.name,
        rule.criteria,
        rule.judgeModel,
        // Same narrowing the worker applies, so a preview predicts what live
        // scoring will actually do (issue #505).
        judgeableOutput(previewOutput),
        rule.judgePromptId,
      );
      verdicts.push({ spanId: span.id, traceId: span.traceId, ...verdict });
    }
    return verdicts;
  }

  /**
   * Builds a dataset from this rule's own below-threshold scores, using the
   * *rule's* `criteria` (a standing instruction) — never a score's `reason`
   * (a critique of one answer). See phase-5-faq Q23 for why that distinction
   * is load-bearing.
   *
   * @throws {NotFoundError} same as `getRule`.
   */
  async buildDataset(
    id: string,
    teamId: string,
    actorId: string,
    input: ToDatasetDto,
  ): Promise<{ id: string; exampleCount: number }> {
    const rule = await this.repo.findById(id, teamId);
    if (!rule) throw new NotFoundError('Rule not found.');

    const lowScores = await this.repo.scoresBelow(id, teamId, input.threshold, input.limit);
    // `createdBy` was null here and the trail had no row, so this was the one
    // dataset in the product that appeared from nowhere and belonged to no one.
    const dataset = await datasetsRepo.createDataset(teamId, actorId, { name: input.datasetName });
    await audit(prisma, {
      teamId,
      actorId,
      event: 'dataset_created',
      metadata: { datasetId: dataset.id, name: dataset.name, fromRuleId: id },
    });

    let exampleCount = 0;
    for (const scoreRow of lowScores) {
      const payload = await prisma.spanPayload.findUnique({ where: { spanId: scoreRow.spanId } });
      if (!payload) continue;
      await datasetsRepo.createExample(teamId, dataset.id, {
        input: (payload.variables ?? payload.input ?? {}) as Prisma.InputJsonValue,
        criteria: rule.criteria,
        sourceTraceId: scoreRow.traceId,
      });
      exampleCount += 1;
    }
    return { id: dataset.id, exampleCount };
  }

  /**
   * Shared judge call used by both `previewRule` and the worker (Task 9).
   * Neither caller persists anything here — this method only runs the judge
   * completion and parses its verdict; the worker (Task 9) is responsible
   * for writing the resulting score via `EvalRuleRepository.upsertScore`.
   * The judge's own gateway call still produces a real trace either way,
   * marked with `JUDGE_MARKER` so nothing else scores it.
   *
   * @param teamId - Isolation boundary, and the team whose gateway connection judges the call.
   * @param ruleName - The calling rule's name, threaded into the judge's own gateway call
   *   as `contributingSource` so a budget-exhaustion alert triggered by this judge call
   *   can name the rule responsible.
   * @param criteria - The rule's standing instruction, never a score's `reason`.
   * @param judgeModel - Rule-configured judge model. Required for any rule created or
   *   updated after the online-eval-rule redesign (phase-5-faq); a `null` here can only
   *   mean a legacy row the backfill migration couldn't resolve (the team had zero
   *   registered models at the time) — handled as a graceful failed verdict, not a crash.
   * @param output - The candidate output being judged (stringified by `compileEvaluatePrompt` if not already a string).
   * @param judgePromptId - Optional team Prompt to use as the judge template instead of
   *   the built-in one (phase-5-faq). Null/undefined uses the built-in judge.
   * @returns The parsed verdict, or a null score/passed/reason on a judge parse failure — plus the judge call's own trace id.
   */
  async judge(
    teamId: string,
    ruleName: string,
    criteria: string,
    judgeModel: string | null,
    output: unknown,
    judgePromptId?: string | null,
  ): Promise<{ score: number | null; passed: boolean | null; reason: string | null; judgeTraceId: string }> {
    const judgeTraceId = randomUUID();
    if (!judgeModel) {
      return { score: null, passed: null, reason: 'no judge model configured for this rule', judgeTraceId };
    }

    let messages;
    try {
      messages = judgePromptId
        ? await compileCustomJudgePrompt(judgePromptId, { output, criteria, overallFeedback: null })
        : compileEvaluatePrompt({ output, criteria, overallFeedback: null });
    } catch (err) {
      return {
        score: null,
        passed: null,
        reason: `judge prompt error: ${err instanceof Error ? err.message : String(err)}`,
        judgeTraceId,
      };
    }

    const result = await gateway.complete(
      {
        teamId,
        traceId: judgeTraceId,
        spanMetadata: { [JUDGE_MARKER]: true },
        contributingSource: `online evaluation rule "${ruleName}"`,
      },
      { model: judgeModel, messages, temperature: 0, max_tokens: 300 },
    );
    const content = result.body.choices[0]?.message.content ?? '';
    const verdict = parseVerdict(content);
    if (!verdict) {
      return { score: null, passed: null, reason: 'judge parse error', judgeTraceId };
    }
    return { score: verdict.score, passed: verdict.passed, reason: verdict.reason, judgeTraceId };
  }
}

export const onlineEvalRuleService = new OnlineEvalRuleService(new EvalRuleRepository());
