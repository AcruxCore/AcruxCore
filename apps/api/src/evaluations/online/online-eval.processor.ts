import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import { PaymentRequiredError } from '../../shared/errors';
import { appLink } from '../../email';
// Imported from the concrete file, not the `../../notifications` barrel: that
// barrel re-exports `notificationsRouter`, which pulls in Express as a load-time
// side effect. This processor is part of apps/worker's dependency graph, which is
// deliberately Express-free (see `finalize.processor.ts`'s identical comment).
import { notify } from '../../notifications/notify';
import { MembersRepository } from '../../teams/members/members.repository';
import { EvalRuleRepository } from './online-eval-rule.repository';
import { matchesFilter } from './eval-rule-matcher';
import { onlineEvalRuleService, JUDGE_MARKER } from './online-eval-rule.service';
import type { OnlineEvalJobData } from './online-eval.queue';
import type { EvalRuleFilter } from './online-eval-rule.types';

/** In-process rule cache lifetime. A rule edit taking half a minute to take effect is fine; a query per span is not. */
const RULE_CACHE_TTL_MS = 30_000;

const repo = new EvalRuleRepository();
const members = new MembersRepository();

/** One row from `EvalRuleRepository.listAllEnabled` — a rule together with its Prisma `Decimal`/`Json` fields as stored. */
type EnabledRule = Awaited<ReturnType<EvalRuleRepository['listAllEnabled']>>[number];

/** A span plus the trace fields and payload the matcher/judge need — precise Prisma include shape, not a generic `findUnique` inference. */
type SpanWithTraceAndPayload = Prisma.SpanGetPayload<{
  include: { trace: { select: { sessionId: true } }; payload: true };
}>;

interface CachedRules {
  rules: EnabledRule[];
  expiresAt: number;
}
let rulesCache: CachedRules | null = null;

/** 30s in-process cache of every enabled rule across every team — a rule edit taking half a minute to take effect is fine; a query per span is not. */
async function getEnabledRules(): Promise<EnabledRule[]> {
  if (rulesCache && rulesCache.expiresAt > Date.now()) return rulesCache.rules;
  const rules = await repo.listAllEnabled();
  rulesCache = { rules, expiresAt: Date.now() + RULE_CACHE_TTL_MS };
  return rules;
}

/**
 * Exposed for tests that need to force a re-read after seeding a rule
 * mid-test, and used internally after a rule is auto-disabled so the cache
 * doesn't keep serving it as enabled for the rest of its TTL.
 *
 * @returns Nothing. Drops the cached rule list; the next `getEnabledRules()` call re-queries.
 */
export function invalidateRuleCache(): void {
  rulesCache = null;
}

/**
 * Processes one online-eval job: matches every enabled rule against the span,
 * samples, checks the daily cap, judges, and persists a score. Never throws
 * on an expected failure mode (missing payload, budget exhaustion) — those
 * are first-class outcomes, not errors. A genuinely unexpected error (DB
 * down, etc.) is allowed to throw so BullMQ's own retry/backoff applies.
 *
 * The judge-loop guard below is deliberately doubled and runs before any
 * rule-matching logic: without it, a rule would score its own judge call,
 * which would produce another judge call for some rule to score, forever.
 *
 * @param data - The job payload: ids only — every read happens here, never at enqueue time.
 * @returns Nothing. Every outcome (matched-and-scored, sampled-out, no
 *   payload, budget-exhausted-and-disabled) is a side effect on `EvalRuleScore`
 *   or `EvalRule`, never a return value.
 * @throws Whatever the underlying DB call throws, unmodified, so BullMQ can retry.
 */
export async function processOnlineEval(data: OnlineEvalJobData): Promise<void> {
  // Kind gate (defensive — call sites already only enqueue llm spans).
  if (data.spanKind !== 'llm') return;

  // team-scoped: every query in this file must be (Global Constraints) — a
  // spanId/teamId mismatch (enqueue bug, replayed job against a restored DB)
  // must never let this team's judge see another team's captured content.
  const span = await prisma.span.findFirst({
    where: { id: data.spanId, teamId: data.teamId },
    include: { trace: { select: { sessionId: true } }, payload: true },
  });
  if (!span) return;

  // Judge-trace gate, doubled, and BEFORE any rule matching. Without this a
  // rule scores its own judge call, which scores its own judge call, forever.
  // 1) A span-level marker the judge's own gateway call stamps on itself —
  //    this is what catches the judge's own span directly, on its very next job.
  const metadata = (span.metadata ?? {}) as Record<string, unknown>;
  if (metadata[JUDGE_MARKER] === true) return;
  // 2) A repository lookup by trace id: the fallback for any LATER span on an
  //    already-scored judge trace (it can only recognize a trace that already
  //    has a score row, so it never covers the judge's own immediate next
  //    span — guard #1 above is what covers that case).
  if (await repo.isJudgeTrace(data.traceId)) return;

  // Load enabled rules (cached) only once both guards above have cleared.
  const rules = await getEnabledRules();
  const teamRules = rules.filter((r) => r.teamId === data.teamId);
  if (teamRules.length === 0) return;

  for (const rule of teamRules) {
    await processOneRule(rule, data, span);
  }
}

/** Runs one rule against one already-guard-cleared span: match, sample, daily cap, judge, persist, alert. */
async function processOneRule(
  rule: EnabledRule,
  data: OnlineEvalJobData,
  span: SpanWithTraceAndPayload,
): Promise<void> {
  const filter = rule.filter as EvalRuleFilter;
  const isMatch = await matchesFilter(filter, {
    promptVersionId: span.promptVersionId,
    model: span.model,
    tags: span.tags,
    sessionId: span.trace.sessionId,
  });
  if (!isMatch) return;

  // Sample. Before the payload read, so the cheap path stays cheap.
  if (Math.random() >= rule.sampleRate.toNumber()) return;

  // Daily limit.
  if (rule.dailyLimit !== null) {
    const todayCount = await repo.countTodayScores(rule.id, data.teamId);
    if (todayCount >= rule.dailyLimit) {
      console.log(`[online-eval] rule ${rule.id} hit its daily limit (${rule.dailyLimit})`);
      return;
    }
  }

  // Read the payload. Missing payload is a first-class outcome.
  const output = span.payload?.output;
  if (output === undefined || output === null) {
    await repo.upsertScore({
      teamId: data.teamId,
      ruleId: rule.id,
      traceId: data.traceId,
      spanId: data.spanId,
      score: null,
      passed: null,
      reason: 'not scored: payload capture is off for this team',
      judgeTraceId: null,
      costUsd: null,
    });
    return;
  }

  // Judge, then persist.
  try {
    const verdict = await onlineEvalRuleService.judge(
      data.teamId,
      rule.name,
      rule.criteria,
      rule.judgeModel,
      output,
      rule.judgePromptId,
    );
    await repo.upsertScore({
      teamId: data.teamId,
      ruleId: rule.id,
      traceId: data.traceId,
      spanId: data.spanId,
      score: verdict.score,
      passed: verdict.passed,
      reason: verdict.reason,
      judgeTraceId: verdict.judgeTraceId,
      costUsd: null,
    });

    // Alert.
    if (rule.alertBelow !== null && verdict.score !== null && verdict.score < rule.alertBelow) {
      await sendAlert(rule, verdict);
    }
  } catch (err) {
    if (err instanceof PaymentRequiredError) {
      // Disables and notifies (spec: "a 402 from the judge disables the rule and
      // notifies, rather than retrying"). This is a SEPARATE, `eval_rules`-category
      // notice from the platform's own `budget_exhausted` email — that one already
      // fired (or will fire) on whichever call actually crossed the cap, with the
      // real budget's teamName/scopeLabel/limitUsd/spendUsd; this processor has none
      // of those and must not fabricate a `budget_exhausted` payload missing them.
      await repo.disable(rule.id, data.teamId);
      // Without this, the 30s in-process cache keeps serving the just-disabled
      // rule as enabled, so the next job(s) within that window re-attempt it
      // and re-disable it again (no spend, no duplicate email — the disable's
      // dedupe key has no time component — but pure churn worth closing).
      invalidateRuleCache();
      await sendDisabledAlert(rule);
      return;
    }
    throw err;
  }
}

/** Notifies the team's owners that a live trace scored below `rule.alertBelow`. */
async function sendAlert(
  rule: EnabledRule,
  verdict: { score: number | null; reason: string | null },
): Promise<void> {
  const utcDateKey = new Date().toISOString().slice(0, 10);
  await notify({
    teamId: rule.teamId,
    category: 'eval_rules',
    audience: { fallbackRoles: ['owner'] },
    dedupeKey: `eval-rule-alert:${rule.id}:${utcDateKey}`,
    payload: {
      type: 'eval_rule_alert',
      props: {
        teamName: (await members.findTeamName(rule.teamId)) ?? 'your team',
        ruleName: rule.name,
        score: verdict.score,
        reason: verdict.reason ?? '',
        rulesUrl: appLink('/evaluations/rules'),
      },
    },
  });
}

/** Notifies the team's owners that this rule was auto-disabled after its judge call hit the team's budget cap. */
async function sendDisabledAlert(rule: EnabledRule): Promise<void> {
  await notify({
    teamId: rule.teamId,
    category: 'eval_rules',
    audience: { fallbackRoles: ['owner'] },
    dedupeKey: `eval-rule-disabled:${rule.id}`,
    payload: {
      type: 'eval_rule_alert',
      props: {
        teamName: (await members.findTeamName(rule.teamId)) ?? 'your team',
        ruleName: rule.name,
        score: null,
        reason: "This rule was disabled automatically: its judge calls hit your team's budget cap.",
        rulesUrl: appLink('/evaluations/rules'),
      },
    },
  });
}
