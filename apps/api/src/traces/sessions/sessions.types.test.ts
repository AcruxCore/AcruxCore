import { SessionListQuerySchema } from './sessions.types';

describe('SessionListQuerySchema', () => {
  it('accepts an empty query and applies defaults', () => {
    const result = SessionListQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
      expect(result.data.from).toBeUndefined();
      expect(result.data.to).toBeUndefined();
      expect(result.data.q).toBeUndefined();
    }
  });

  it('accepts a fully specified valid query', () => {
    const result = SessionListQuerySchema.safeParse({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
      page: '2',
      limit: '50',
      q: 'session-abc',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from).toBeInstanceOf(Date);
      expect(result.data.to).toBeInstanceOf(Date);
      expect(result.data.page).toBe(2);
      expect(result.data.limit).toBe(50);
      expect(result.data.q).toBe('session-abc');
    }
  });

  it('rejects a non-ISO from date', () => {
    const result = SessionListQuerySchema.safeParse({ from: 'not-a-date' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO to date', () => {
    const result = SessionListQuerySchema.safeParse({ to: 'not-a-date' });
    expect(result.success).toBe(false);
  });

  it('rejects a limit above 100', () => {
    const result = SessionListQuerySchema.safeParse({ limit: '101' });
    expect(result.success).toBe(false);
  });

  it('rejects a limit below 1', () => {
    const result = SessionListQuerySchema.safeParse({ limit: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects a page below 1', () => {
    const result = SessionListQuerySchema.safeParse({ page: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    const result = SessionListQuerySchema.safeParse({ limit: '20.5' });
    expect(result.success).toBe(false);
  });

  it('treats an empty or whitespace-only q as a no-op (no filter), not an error', () => {
    const empty = SessionListQuerySchema.safeParse({ q: '' });
    expect(empty.success).toBe(true);
    if (empty.success) {
      expect(empty.data.q).toBeUndefined();
    }

    const whitespace = SessionListQuerySchema.safeParse({ q: '   ' });
    expect(whitespace.success).toBe(true);
    if (whitespace.success) {
      expect(whitespace.data.q).toBeUndefined();
    }
  });

  it('trims whitespace from q', () => {
    const result = SessionListQuerySchema.safeParse({ q: '  session-1  ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.q).toBe('session-1');
    }

    const result2 = SessionListQuerySchema.safeParse({ q: '  hello ' });
    expect(result2.success).toBe(true);
    if (result2.success) {
      expect(result2.data.q).toBe('hello');
    }
  });
});
