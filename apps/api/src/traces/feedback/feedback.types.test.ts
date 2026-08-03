import { CreateFeedbackSchema, FeedbackSummaryQuerySchema } from './feedback.types';

describe('feedback Zod schemas', () => {
  it('accepts a body with only a comment and defaults source to "user"', () => {
    const parsed = CreateFeedbackSchema.safeParse({ comment: 'Cited the wrong policy.' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.source).toBe('user');
  });

  it('accepts a rating-only thumbs-down body', () => {
    const parsed = CreateFeedbackSchema.safeParse({ rating: -1 });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty body (no rating/label/comment)', () => {
    const parsed = CreateFeedbackSchema.safeParse({ source: 'end_user' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a rating above the [-1, 5] range', () => {
    const parsed = CreateFeedbackSchema.safeParse({ rating: 9 });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-integer rating', () => {
    const parsed = CreateFeedbackSchema.safeParse({ rating: 1.5 });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown source value', () => {
    const parsed = CreateFeedbackSchema.safeParse({ comment: 'x', source: 'robot' });
    expect(parsed.success).toBe(false);
  });

  it('accepts an optional spanId alongside a comment', () => {
    const parsed = CreateFeedbackSchema.safeParse({ comment: 'x', spanId: 'span-abc' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.spanId).toBe('span-abc');
  });

  it('summary query defaults group_by to prompt_version', () => {
    const parsed = FeedbackSummaryQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.group_by).toBe('prompt_version');
  });

  it('rejects a bad group_by value', () => {
    const parsed = FeedbackSummaryQuerySchema.safeParse({ group_by: 'nonsense' });
    expect(parsed.success).toBe(false);
  });
});
