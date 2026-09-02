import {
  ProviderError,
  GATEWAY_TIMEOUT_MS,
  getAdapter,
  summarizeProviderDetail,
  MAX_PROVIDER_DETAIL,
  parseRetryAfter,
} from './adapter';

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

describe('summarizeProviderDetail (issue #356)', () => {
  it('unwraps the message a provider nests under error.message', () => {
    // The real shape of an OpenAI strict-mode 400. Before this, adapters read this body
    // to log it and then threw it away, so the caller learned only "status 400" and had
    // no way to tell two different schema mistakes apart.
    const body = JSON.stringify({
      error: {
        message:
          "In context=('properties','b'), 'required' is required to be supplied and to be an array including every key in properties",
        type: 'invalid_request_error',
      },
    });
    expect(summarizeProviderDetail(body)).toBe(
      "In context=('properties','b'), 'required' is required to be supplied and to be an array including every key in properties",
    );
  });

  it('handles a provider that puts a plain string under error', () => {
    expect(summarizeProviderDetail(JSON.stringify({ error: 'model not found' }))).toBe('model not found');
  });

  it('passes non-JSON bodies through as text', () => {
    expect(summarizeProviderDetail('<html>502 Bad Gateway</html>')).toBe('<html>502 Bad Gateway</html>');
  });

  it('collapses whitespace, because a pretty-printed body lands in a one-line message', () => {
    const body = JSON.stringify({ error: { message: 'line one\n  line two' } }, null, 2);
    expect(summarizeProviderDetail(body)).toBe('line one line two');
  });

  it('truncates a very long body rather than pasting it whole into an error message', () => {
    const long = 'x'.repeat(MAX_PROVIDER_DETAIL + 200);
    const out = summarizeProviderDetail(long)!;
    expect(out).toHaveLength(MAX_PROVIDER_DETAIL + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns undefined for an empty or whitespace body', () => {
    expect(summarizeProviderDetail('')).toBeUndefined();
    expect(summarizeProviderDetail('   \n ')).toBeUndefined();
  });

  it('is carried on ProviderError as `detail`, separate from `message`', () => {
    const err = new ProviderError('OpenAI request failed with status 400', 400, undefined, false, 'the real reason');
    expect(err.message).toBe('OpenAI request failed with status 400');
    expect(err.detail).toBe('the real reason');
  });
});

describe('parseRetryAfter (issue: provider 429 passthrough)', () => {
  it('reads the delta-seconds form', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '20' }))).toBe(20);
  });

  it('reads the HTTP-date form as seconds from now', () => {
    const when = new Date(Date.now() + 30_000).toUTCString();
    const seconds = parseRetryAfter(new Headers({ 'retry-after': when }));
    // Clock granularity: the header only carries whole seconds.
    expect(seconds).toBeGreaterThanOrEqual(28);
    expect(seconds).toBeLessThanOrEqual(30);
  });

  it('is undefined when the header is absent, unparseable, or in the past', () => {
    expect(parseRetryAfter(new Headers())).toBeUndefined();
    expect(parseRetryAfter(new Headers({ 'retry-after': 'soon' }))).toBeUndefined();
    expect(parseRetryAfter(new Headers({ 'retry-after': '-5' }))).toBeUndefined();
    expect(parseRetryAfter(new Headers({ 'retry-after': new Date(Date.now() - 60_000).toUTCString() }))).toBeUndefined();
  });

  it('tolerates a response whose headers are missing entirely', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});
