import { ProviderError, GATEWAY_TIMEOUT_MS, getAdapter } from './adapter';

describe('ProviderError', () => {
  it('carries status, providerCode, retriable', () => {
    const err = new ProviderError('rate limited', 429, 'rate_limit_exceeded', true);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(429);
    expect(err.providerCode).toBe('rate_limit_exceeded');
    expect(err.retriable).toBe(true);
    expect(err.message).toBe('rate limited');
  });

  it('defaults retriable to false', () => {
    const err = new ProviderError('bad request', 400);
    expect(err.retriable).toBe(false);
    expect(err.providerCode).toBeUndefined();
  });

  it('exposes a sane default timeout', () => {
    expect(GATEWAY_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('getAdapter registry', () => {
  it('returns the adapter matching the provider kind', () => {
    expect(getAdapter('openai').provider).toBe('openai');
    expect(getAdapter('anthropic').provider).toBe('anthropic');
    expect(getAdapter('openai_compatible').provider).toBe('openai_compatible');
    expect(getAdapter('gemini').provider).toBe('gemini');
  });

  it('throws on an unknown provider', () => {
    expect(() => getAdapter('cohere')).toThrow(/unknown provider/i);
  });
});
