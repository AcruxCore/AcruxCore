import { AnalyticsQuerySchema } from './analytics.types';

describe('AnalyticsQuerySchema', () => {
  it('accepts an empty query and applies defaults', () => {
    const result = AnalyticsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.group_by).toBe('day');
      expect(result.data.from).toBeUndefined();
      expect(result.data.to).toBeUndefined();
      expect(result.data.kind).toBeUndefined();
      expect(result.data.model).toBeUndefined();
    }
  });

  it('accepts a fully specified valid query and coerces types', () => {
    const result = AnalyticsQuerySchema.safeParse({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
      group_by: 'model',
      kind: 'llm',
      model: 'gpt-4o',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from).toBeInstanceOf(Date);
      expect(result.data.to).toBeInstanceOf(Date);
      expect(result.data.group_by).toBe('model');
      expect(result.data.kind).toBe('llm');
      expect(result.data.model).toBe('gpt-4o');
    }
  });

  it('accepts every valid group_by enum value', () => {
    for (const group_by of ['day', 'model', 'session', 'prompt_version']) {
      const result = AnalyticsQuerySchema.safeParse({ group_by });
      expect(result.success).toBe(true);
    }
  });

  it('rejects an invalid group_by enum value', () => {
    const result = AnalyticsQuerySchema.safeParse({ group_by: 'bogus' });
    expect(result.success).toBe(false);
  });

  it('accepts every valid kind enum value', () => {
    for (const kind of ['llm', 'tool', 'retrieval', 'embedding', 'agent', 'chain', 'other']) {
      const result = AnalyticsQuerySchema.safeParse({ kind });
      expect(result.success).toBe(true);
    }
  });

  it('rejects an invalid kind enum value', () => {
    const result = AnalyticsQuerySchema.safeParse({ kind: 'bogus' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO from date', () => {
    const result = AnalyticsQuerySchema.safeParse({ from: 'not-a-date' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO to date', () => {
    const result = AnalyticsQuerySchema.safeParse({ to: 'not-a-date' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty model string', () => {
    const result = AnalyticsQuerySchema.safeParse({ model: '' });
    expect(result.success).toBe(false);
  });

  it('rejects when from is after to', () => {
    const result = AnalyticsQuerySchema.safeParse({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-06-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('accepts when from equals to', () => {
    const result = AnalyticsQuerySchema.safeParse({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });
});
