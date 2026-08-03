import { TraceListQuerySchema, PromptVersionTracesQuerySchema } from './query.types';

describe('TraceListQuerySchema', () => {
  it('accepts an empty query and applies defaults', () => {
    const result = TraceListQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
      expect(result.data.from).toBeUndefined();
      expect(result.data.to).toBeUndefined();
      expect(result.data.status).toBeUndefined();
      expect(result.data.model).toBeUndefined();
      expect(result.data.session_id).toBeUndefined();
      expect(result.data.prompt_version_id).toBeUndefined();
      expect(result.data.min_latency_ms).toBeUndefined();
      expect(result.data.min_cost_usd).toBeUndefined();
      expect(result.data.min_tokens).toBeUndefined();
      expect(result.data.q).toBeUndefined();
    }
  });

  it('accepts a fully specified valid query and coerces types', () => {
    const result = TraceListQuerySchema.safeParse({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
      status: 'error',
      model: 'gpt-4o',
      session_id: 'session-1',
      prompt_version_id: '11111111-1111-4111-8111-111111111111',
      min_latency_ms: '100',
      min_cost_usd: '0.5',
      min_tokens: '20',
      q: 'checkout',
      page: '2',
      limit: '50',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from).toBeInstanceOf(Date);
      expect(result.data.to).toBeInstanceOf(Date);
      expect(result.data.status).toBe('error');
      expect(result.data.model).toBe('gpt-4o');
      expect(result.data.session_id).toBe('session-1');
      expect(result.data.prompt_version_id).toBe('11111111-1111-4111-8111-111111111111');
      expect(result.data.min_latency_ms).toBe(100);
      expect(result.data.min_cost_usd).toBe(0.5);
      expect(result.data.min_tokens).toBe(20);
      expect(result.data.q).toBe('checkout');
      expect(result.data.page).toBe(2);
      expect(result.data.limit).toBe(50);
    }
  });

  it('rejects a non-ISO from date', () => {
    const result = TraceListQuerySchema.safeParse({ from: 'not-a-date' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO to date', () => {
    const result = TraceListQuerySchema.safeParse({ to: 'not-a-date' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid status enum value', () => {
    const result = TraceListQuerySchema.safeParse({ status: 'bogus' });
    expect(result.success).toBe(false);
  });

  it('accepts every valid status enum value', () => {
    for (const status of ['ok', 'error', 'unset']) {
      const result = TraceListQuerySchema.safeParse({ status });
      expect(result.success).toBe(true);
    }
  });

  it('rejects an empty model string', () => {
    const result = TraceListQuerySchema.safeParse({ model: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty session_id string', () => {
    const result = TraceListQuerySchema.safeParse({ session_id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-UUID prompt_version_id', () => {
    const result = TraceListQuerySchema.safeParse({ prompt_version_id: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('rejects a negative min_latency_ms', () => {
    const result = TraceListQuerySchema.safeParse({ min_latency_ms: '-1' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer min_latency_ms', () => {
    const result = TraceListQuerySchema.safeParse({ min_latency_ms: '1.5' });
    expect(result.success).toBe(false);
  });

  it('rejects a negative min_cost_usd', () => {
    const result = TraceListQuerySchema.safeParse({ min_cost_usd: '-0.5' });
    expect(result.success).toBe(false);
  });

  it('accepts a fractional min_cost_usd', () => {
    const result = TraceListQuerySchema.safeParse({ min_cost_usd: '0.001' });
    expect(result.success).toBe(true);
  });

  it('rejects a negative min_tokens', () => {
    const result = TraceListQuerySchema.safeParse({ min_tokens: '-1' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer min_tokens', () => {
    const result = TraceListQuerySchema.safeParse({ min_tokens: '1.5' });
    expect(result.success).toBe(false);
  });

  it('treats an empty or whitespace-only q as a no-op (no filter), not an error', () => {
    const empty = TraceListQuerySchema.safeParse({ q: '' });
    expect(empty.success).toBe(true);
    if (empty.success) {
      expect(empty.data.q).toBeUndefined();
    }

    const whitespace = TraceListQuerySchema.safeParse({ q: '   ' });
    expect(whitespace.success).toBe(true);
    if (whitespace.success) {
      expect(whitespace.data.q).toBeUndefined();
    }
  });

  it('trims whitespace from q', () => {
    const result = TraceListQuerySchema.safeParse({ q: '  foo ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.q).toBe('foo');
    }
  });

  it('rejects a limit above 100', () => {
    const result = TraceListQuerySchema.safeParse({ limit: '101' });
    expect(result.success).toBe(false);
  });

  it('rejects a limit below 1', () => {
    const result = TraceListQuerySchema.safeParse({ limit: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects a page below 1', () => {
    const result = TraceListQuerySchema.safeParse({ page: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    const result = TraceListQuerySchema.safeParse({ limit: '20.5' });
    expect(result.success).toBe(false);
  });

  it('accepts a single tags value as a one-element array', () => {
    const result = TraceListQuerySchema.safeParse({ tags: 'prod' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tags).toEqual(['prod']);
  });

  it('accepts repeated tags values as an array', () => {
    const result = TraceListQuerySchema.safeParse({ tags: ['prod', 'nl'] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tags).toEqual(['prod', 'nl']);
  });

  it('accepts a metadata object of string values', () => {
    const result = TraceListQuerySchema.safeParse({ metadata: { env: 'prod', lang: 'nl' } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.metadata).toEqual({ env: 'prod', lang: 'nl' });
  });

  it('omits tags/metadata from the parsed result when absent', () => {
    const result = TraceListQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toBeUndefined();
      expect(result.data.metadata).toBeUndefined();
    }
  });
});

describe('PromptVersionTracesQuerySchema', () => {
  it('accepts an empty query and applies defaults', () => {
    const result = PromptVersionTracesQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
    }
  });

  it('coerces string page/limit to numbers', () => {
    const result = PromptVersionTracesQuerySchema.safeParse({ page: '3', limit: '10' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(3);
      expect(result.data.limit).toBe(10);
    }
  });

  it('rejects a limit above 100', () => {
    const result = PromptVersionTracesQuerySchema.safeParse({ limit: '101' });
    expect(result.success).toBe(false);
  });

  it('rejects a page below 1', () => {
    const result = PromptVersionTracesQuerySchema.safeParse({ page: '0' });
    expect(result.success).toBe(false);
  });
});
