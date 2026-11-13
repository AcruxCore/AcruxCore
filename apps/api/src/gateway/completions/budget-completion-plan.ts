import { Prisma } from '@prisma/client';
import { computeCostFromPrices } from '../providers/models';
import { estimateTokens } from '../providers/token-estimate';
import { ANTHROPIC_DEFAULT_MAX_TOKENS } from '../providers/anthropic.adapter';
import type { NormalizedRequest } from '../providers/types';

/**
 * Completion tokens a reservation is priced on when no budget applies to the call and
 * the caller named no `max_tokens`. With no budget nothing is reserved, so this only
 * keeps the estimate defined.
 */
export const DEFAULT_ESTIMATED_COMPLETION_TOKENS = 1000;

/**
 * Output tokens the money left in every applicable budget must pay for before a call
 * that names no `max_tokens` is sent uncapped.
 *
 * The model registry holds no per-model output limit, so this stands in for "a long
 * answer". An uncapped call reserves exactly this many output tokens, so parallel
 * uncapped calls can only start while each one's long answer is paid for; only a single
 * answer longer than this can still pass the budget.
 */
export const BUDGET_UNCAPPED_MIN_TOKENS = 32_000;

/**
 * Highest `max_tokens` the gateway sets on a call near its budget limit. Every chat
 * model the gateway routes to accepts at least 4096 output tokens, so the value is
 * never refused upstream as too large for the model.
 */
export const BUDGET_NEAR_LIMIT_MAX_TOKENS = 4_096;

/**
 * Safety margins for the near-limit cap. `estimateTokens` undercounts a real prompt:
 * it leaves out each message's framing tokens and approximates non-OpenAI tokenizers.
 * Counting the prompt at 1.5x and keeping 5% of the money left unspent keeps a capped
 * call inside its budget when the provider bills more prompt tokens than estimated.
 */
const BUDGET_PROMPT_ESTIMATE_FACTOR = 1.5;
const BUDGET_REMAINDER_HELD_BACK = 0.05;

/**
 * The output limit a provider's adapter sends when the request names none. A near-limit
 * cap above it would make a nearly spent budget buy longer answers than a full one.
 */
const PROVIDER_DEFAULT_MAX_TOKENS: Readonly<Record<string, number>> = {
  anthropic: ANTHROPIC_DEFAULT_MAX_TOKENS,
};

/** What a deployment in the call's chain costs, and which provider serves it. */
export interface DeploymentPricing {
  provider: string;
  inputPricePerM: Prisma.Decimal | null;
  outputPricePerM: Prisma.Decimal | null;
}

/** How a call is held to its budgets. */
export interface CompletionPlan {
  /** The `max_tokens` the gateway sets on the call; `undefined` sends it as the caller wrote it. */
  cap?: number;
  /** USD to reserve against each applicable budget before the call. */
  estimatedCostUsd: number;
}

/** The larger of two prices; a missing price counts as nothing. */
function dearer(a: Prisma.Decimal | null, b: Prisma.Decimal | null): Prisma.Decimal | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.greaterThan(b) ? a : b;
}

/**
 * Decides the output cap and the reservation for one call.
 *
 * Prices are the dearest in the chain, input and output each: any deployment may end up
 * serving the call, and the reservation has to cover the one that does. A caller's own
 * `max_tokens` is never changed. With no budget, nothing is capped. Otherwise a call that
 * names no limit goes out uncapped while the money left pays for
 * {@link BUDGET_UNCAPPED_MIN_TOKENS} output tokens (and reserves that much), and is held to
 * what the money buys when it does not: at most {@link BUDGET_NEAR_LIMIT_MAX_TOKENS}, and
 * never above the output limit a provider in the chain would send by default.
 *
 * @param req - The call as the caller sent it; only `messages`, `model` and `max_tokens` are read.
 * @param chain - Pricing of every deployment the call may go to, primary first. Non-empty.
 * @param remainingUsd - The least money left across the applicable budgets, or
 *   `undefined` when no budget applies.
 * @returns The cap to set (if any) and the USD to reserve. An unpriced chain reserves 0
 *   and is never capped, as its calls are recorded at no cost.
 */
export function planBudgetedCompletion(
  req: Pick<NormalizedRequest, 'messages' | 'model' | 'max_tokens'>,
  chain: DeploymentPricing[],
  remainingUsd: number | undefined,
): CompletionPlan {
  const input = chain.reduce<Prisma.Decimal | null>((p, d) => dearer(p, d.inputPricePerM), null);
  const output = chain.reduce<Prisma.Decimal | null>((p, d) => dearer(p, d.outputPricePerM), null);
  const promptTokens = estimateTokens(req.messages, req.model);
  const costOf = (completionTokens: number, promptFactor = 1): number =>
    computeCostFromPrices(input, output, {
      prompt_tokens: Math.ceil(promptTokens * promptFactor),
      completion_tokens: completionTokens,
      total_tokens: Math.ceil(promptTokens * promptFactor) + completionTokens,
    }) ?? 0;

  if (req.max_tokens !== undefined) return { estimatedCostUsd: costOf(req.max_tokens) };
  const outputUsdPerToken = output ? output.toNumber() / 1_000_000 : 0;
  if (remainingUsd === undefined || !(outputUsdPerToken > 0)) {
    return { estimatedCostUsd: costOf(DEFAULT_ESTIMATED_COMPLETION_TOKENS) };
  }

  const spendableUsd =
    remainingUsd * (1 - BUDGET_REMAINDER_HELD_BACK) - costOf(0, BUDGET_PROMPT_ESTIMATE_FACTOR);
  const affordable = Math.floor(spendableUsd / outputUsdPerToken);
  if (affordable >= BUDGET_UNCAPPED_MIN_TOKENS) {
    return { estimatedCostUsd: costOf(BUDGET_UNCAPPED_MIN_TOKENS) };
  }
  const providerDefault = Math.min(
    ...chain.map((d) => PROVIDER_DEFAULT_MAX_TOKENS[d.provider] ?? Number.POSITIVE_INFINITY),
  );
  const cap = Math.max(1, Math.min(affordable, BUDGET_NEAR_LIMIT_MAX_TOKENS, providerDefault));
  return { cap, estimatedCostUsd: costOf(cap) };
}
