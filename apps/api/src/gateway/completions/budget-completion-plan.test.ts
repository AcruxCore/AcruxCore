import { Prisma } from '@prisma/client';
import { planBudgetedCompletion, BUDGET_UNCAPPED_MIN_TOKENS } from './budget-completion-plan';

/** A deployment at $10 per million tokens each way. */
function at10(provider: string) {
  return { provider, inputPricePerM: new Prisma.Decimal(10), outputPricePerM: new Prisma.Decimal(10) };
}

const ASK = { model: 'm', messages: [{ role: 'user' as const, content: 'Write a long story.' }] };

describe('planBudgetedCompletion', () => {
  it('never raises an Anthropic call above the 1024 tokens it gets with no budget at all', () => {
    // $0.30 at $10/M buys about 28,000 tokens: short of a long answer, so the call is capped.
    const plan = planBudgetedCompletion(ASK, [at10('anthropic')], 0.3);
    expect(plan.cap).toBe(1024);
  });

  it('applies the lowest default when an Anthropic model is a fallback', () => {
    expect(planBudgetedCompletion(ASK, [at10('openai'), at10('anthropic')], 0.3).cap).toBe(1024);
  });

  it('caps an OpenAI-shaped call at 4096 in the same spot', () => {
    expect(planBudgetedCompletion(ASK, [at10('openai_compatible')], 0.3).cap).toBe(4096);
  });

  it('reserves a long answer for a call it leaves uncapped', () => {
    const plan = planBudgetedCompletion(ASK, [at10('anthropic')], 1000);
    expect(plan.cap).toBeUndefined();
    expect(plan.estimatedCostUsd).toBeGreaterThanOrEqual((BUDGET_UNCAPPED_MIN_TOKENS * 10) / 1_000_000);
  });

  it("leaves a caller's own max_tokens alone and reserves for it", () => {
    const plan = planBudgetedCompletion({ ...ASK, max_tokens: 3000 }, [at10('anthropic')], 0.3);
    expect(plan.cap).toBeUndefined();
    expect(plan.estimatedCostUsd).toBeGreaterThanOrEqual(0.03);
  });

  it('does not cap a call no budget applies to', () => {
    expect(planBudgetedCompletion(ASK, [at10('anthropic')], undefined).cap).toBeUndefined();
  });
});
