import { EvalRuleRepository } from './online-eval-rule.repository';

/** In-process rule cache lifetime. A rule edit taking half a minute to reach another process is fine; a query per span is not. */
const RULE_CACHE_TTL_MS = 30_000;

const repo = new EvalRuleRepository();

/** One row from `EvalRuleRepository.listAllEnabled`: a rule with its Prisma `Decimal`/`Json` fields as stored. */
export type EnabledRule = Awaited<ReturnType<EvalRuleRepository['listAllEnabled']>>[number];

interface CachedRules {
  rules: EnabledRule[];
  expiresAt: number;
}
let rulesCache: CachedRules | null = null;

/**
 * Every enabled rule across every team, cached in this process for 30 s.
 *
 * Both the enqueue side (API) and the processor (worker) read it once per span, so the
 * cache is what keeps a trace burst from costing one rules query per span. Each process
 * holds its own copy: a rule change made through the API invalidates the API's copy at
 * once, and reaches the worker's copy within the TTL.
 *
 * @returns The cached list, re-read from the database when it is older than the TTL.
 */
export async function getEnabledRules(): Promise<EnabledRule[]> {
  if (rulesCache && rulesCache.expiresAt > Date.now()) return rulesCache.rules;
  const rules = await repo.listAllEnabled();
  rulesCache = { rules, expiresAt: Date.now() + RULE_CACHE_TTL_MS };
  return rules;
}

/**
 * Whether a team has at least one enabled online-eval rule, from the cached list.
 *
 * Lets ingest skip queueing an online-eval job for a team that could never be scored,
 * which on a team with no rules was one Redis write and one worker job per LLM span
 * (issue #856).
 *
 * @param teamId - The team the span belongs to.
 * @returns `true` when any enabled rule belongs to the team.
 */
export async function teamHasEnabledRules(teamId: string): Promise<boolean> {
  const rules = await getEnabledRules();
  return rules.some((r) => r.teamId === teamId);
}

/**
 * Drops the cached rule list so the next read re-queries.
 *
 * Called after every rule create, update and delete in this process, so a new rule
 * scores the very next span and a disabled one stops queueing jobs straight away; also
 * after the processor auto-disables a rule, and by tests that seed rules mid-test.
 *
 * @returns Nothing.
 */
export function invalidateRuleCache(): void {
  rulesCache = null;
}
