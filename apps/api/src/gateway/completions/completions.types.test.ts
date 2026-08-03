import { GatewayControlSchema, ChatCompletionRequestSchema } from './completions.types';

describe('GatewayControlSchema', () => {
  it('accepts a valid control object', () => {
    const parsed = GatewayControlSchema.parse({ maxRetries: 2, fallback: true });
    expect(parsed).toEqual({ maxRetries: 2, fallback: true });
  });

  it('rejects maxRetries above the cap', () => {
    expect(() => GatewayControlSchema.parse({ maxRetries: 99 })).toThrow();
  });

  it('rejects unknown control keys', () => {
    expect(() => GatewayControlSchema.parse({ nope: 1 })).toThrow();
  });
});

describe('ChatCompletionRequestSchema', () => {
  it('accepts and preserves an optional gateway field', () => {
    const parsed = ChatCompletionRequestSchema.parse({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      gateway: { maxRetries: 2 },
    });
    expect(parsed.gateway).toEqual({ maxRetries: 2 });
  });

  it('strips unknown top-level keys but keeps gateway', () => {
    const parsed = ChatCompletionRequestSchema.parse({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      surprise: 'drop-me',
    }) as Record<string, unknown>;
    expect('surprise' in parsed).toBe(false);
  });
});
