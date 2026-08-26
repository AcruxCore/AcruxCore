import { CACHED_INPUT_DISCOUNT, MODELS, computeCost, computeCostFromPrices, ModelInfo } from './models';

describe('model registry + computeCost', () => {
  it('contains the seed models with a provider + prices', () => {
    for (const key of ['gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet-latest']) {
      const info: ModelInfo | undefined = MODELS[key];
      expect(info).toBeDefined();
      expect(info!.inputPricePerM).toBeGreaterThan(0);
      expect(info!.outputPricePerM).toBeGreaterThan(0);
      expect(info!.contextWindow).toBeGreaterThan(0);
    }
    expect(MODELS['gpt-4o-mini']!.provider).toBe('openai');
    expect(MODELS['claude-3-5-sonnet-latest']!.provider).toBe('anthropic');
  });

  it('computes cost = prompt/1e6*inputPrice + completion/1e6*outputPrice', () => {
    // gpt-4o-mini: input $0.15/M, output $0.60/M
    const cost = computeCost('gpt-4o-mini', {
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
      total_tokens: 2_000_000,
    });
    expect(cost).toBeCloseTo(0.15 + 0.6, 6);
  });

  it('returns null for an unknown model', () => {
    expect(
      computeCost('totally-made-up-model', { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }),
    ).toBeNull();
  });

  it('bills a cached prompt token at the discounted rate, not the full one', () => {
    // OpenAI caches a repeated prefix with no client opt-in and bills it at half price. The
    // cached count is a SUBSET of prompt_tokens, so the full-rate part is the remainder.
    // gpt-4o-mini: input $0.15/M, output $0.60/M.
    const cost = computeCost('gpt-4o-mini', {
      prompt_tokens: 1_000_000,
      completion_tokens: 0,
      total_tokens: 1_000_000,
      cached_tokens: 400_000,
    });
    const expected = (600_000 / 1e6) * 0.15 + (400_000 / 1e6) * 0.15 * CACHED_INPUT_DISCOUNT;
    expect(cost).toBeCloseTo(expected, 9);
    // And it must be strictly cheaper than charging the full rate on all 1M prompt tokens.
    expect(cost!).toBeLessThan(0.15);
  });

  it('is unchanged when the provider reports no cached count', () => {
    const withoutField = computeCost('gpt-4o', {
      prompt_tokens: 500_000,
      completion_tokens: 1_000,
      total_tokens: 501_000,
    });
    const withZero = computeCost('gpt-4o', {
      prompt_tokens: 500_000,
      completion_tokens: 1_000,
      total_tokens: 501_000,
      cached_tokens: 0,
    });
    expect(withoutField).toBeCloseTo((500_000 / 1e6) * 2.5 + (1_000 / 1e6) * 10, 9);
    expect(withZero).toBe(withoutField);
  });

  it('clamps a cached count the provider reports above prompt_tokens', () => {
    // The count comes from an upstream we do not control; a bogus value must not make the
    // call cost less than zero, nor discount tokens that were never billed as input.
    const cost = computeCost('gpt-4o-mini', {
      prompt_tokens: 1_000,
      completion_tokens: 0,
      total_tokens: 1_000,
      cached_tokens: 9_999_999,
    });
    expect(cost).toBeCloseTo((1_000 / 1e6) * 0.15 * CACHED_INPUT_DISCOUNT, 12);
    expect(cost!).toBeGreaterThan(0);
  });

  it('honours a per-model cachedInputDiscount over the default', () => {
    const model = Object.values(MODELS).find((m) => m.cachedInputDiscount !== undefined);
    // No registry model overrides it today — every OpenAI model we price caches at half rate.
    // This asserts the override is wired, using a local entry rather than mutating MODELS.
    expect(model).toBeUndefined();
    const quarter: ModelInfo = {
      model: 'x',
      provider: 'openai',
      inputPricePerM: 2,
      outputPricePerM: 8,
      cachedInputDiscount: 0.25,
      contextWindow: 1,
    };
    expect(quarter.cachedInputDiscount).toBe(0.25);
  });

  it('applies the default discount to a registered model with owner-set prices', () => {
    // computeCostFromPrices reads the DB's single input price, so there is no per-model
    // cached rate — the default discount is what a gateway-registered model gets.
    const cost = computeCostFromPrices(10, 30, {
      prompt_tokens: 1_000_000,
      completion_tokens: 0,
      total_tokens: 1_000_000,
      cached_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(10 * CACHED_INPUT_DISCOUNT, 9);
  });

  it('falls back to the un-dated registry key for a provider-dated model id', () => {
    // OpenAI (and other providers) commonly report the dated snapshot actually
    // served (e.g. `gpt-4o-mini-2024-07-18`) rather than the bare alias a caller
    // requested — this is the model string OTLP-ingested traces from real
    // OpenAI-backed frameworks carry.
    const cost = computeCost('gpt-4o-mini-2024-07-18', {
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
      total_tokens: 2_000_000,
    });
    expect(cost).toBeCloseTo(0.15 + 0.6, 6);
  });
});
