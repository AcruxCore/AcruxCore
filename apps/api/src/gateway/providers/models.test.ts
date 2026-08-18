import { MODELS, computeCost, ModelInfo } from './models';

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
