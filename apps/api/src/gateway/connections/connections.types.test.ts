import { CreateConnectionSchema, UpdateConnectionSchema } from './connections.types';

describe('connections Zod schemas', () => {
  it('accepts a valid openai create body and defaults config to {}', () => {
    const parsed = CreateConnectionSchema.safeParse({
      provider: 'openai',
      label: 'Prod OpenAI',
      apiKey: 'sk-abc...AB12',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.config).toEqual({});
  });

  it('rejects openai_compatible without config.base_url', () => {
    const parsed = CreateConnectionSchema.safeParse({
      provider: 'openai_compatible',
      label: 'Groq',
      apiKey: 'gsk_123',
      config: {},
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts openai_compatible with a valid base_url', () => {
    const parsed = CreateConnectionSchema.safeParse({
      provider: 'openai_compatible',
      label: 'Groq',
      apiKey: 'gsk_123',
      config: { base_url: 'https://api.groq.com/openai/v1' },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty label', () => {
    const parsed = CreateConnectionSchema.safeParse({ provider: 'openai', label: '', apiKey: 'sk-x' });
    expect(parsed.success).toBe(false);
  });

  it('UpdateConnectionSchema accepts a partial body (label only)', () => {
    const parsed = UpdateConnectionSchema.safeParse({ label: 'renamed' });
    expect(parsed.success).toBe(true);
  });

  it('rejects an openai_compatible base_url pointing at a loopback IP literal', () => {
    const parsed = CreateConnectionSchema.safeParse({
      provider: 'openai_compatible',
      label: 'Evil',
      apiKey: 'gsk_123',
      config: { base_url: 'http://127.0.0.1:6379/' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a plain openai connection with a custom base_url pointing at the cloud metadata address', () => {
    const parsed = CreateConnectionSchema.safeParse({
      provider: 'openai',
      label: 'Evil',
      apiKey: 'sk-abc',
      config: { base_url: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a gemini connection with a custom base_url pointing at a private IP literal', () => {
    const parsed = CreateConnectionSchema.safeParse({
      provider: 'gemini',
      label: 'Evil',
      apiKey: 'AIza-abc',
      config: { base_url: 'http://10.0.0.5/' },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a plain openai connection with a custom, public base_url', () => {
    const parsed = CreateConnectionSchema.safeParse({
      provider: 'openai',
      label: 'Custom OpenAI-compatible proxy',
      apiKey: 'sk-abc',
      config: { base_url: 'https://my-openai-proxy.example.com/v1' },
    });
    expect(parsed.success).toBe(true);
  });

  it('UpdateConnectionSchema rejects a config.base_url pointing at a blocked IP literal', () => {
    const parsed = UpdateConnectionSchema.safeParse({
      config: { base_url: 'http://169.254.169.254/' },
    });
    expect(parsed.success).toBe(false);
  });

  it('UpdateConnectionSchema accepts a config.base_url that is a public URL', () => {
    const parsed = UpdateConnectionSchema.safeParse({
      config: { base_url: 'https://api.groq.com/openai/v1' },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an anthropic connection with a private-range base_url in config (anthropic.adapter.ts never reads it)', () => {
    const parsed = CreateConnectionSchema.safeParse({
      provider: 'anthropic',
      label: 'Claude',
      apiKey: 'sk-ant-abc',
      config: { base_url: 'http://127.0.0.1:6379/' },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an anthropic connection with a malformed (non-URL) base_url in config', () => {
    const parsed = CreateConnectionSchema.safeParse({
      provider: 'anthropic',
      label: 'Claude',
      apiKey: 'sk-ant-abc',
      config: { base_url: 'not-a-url-at-all' },
    });
    expect(parsed.success).toBe(true);
  });

  it('still rejects an openai_compatible base_url pointing at a private IP (validation unaffected by the anthropic exemption)', () => {
    const parsed = CreateConnectionSchema.safeParse({
      provider: 'openai_compatible',
      label: 'Evil proxy',
      apiKey: 'gsk_123',
      config: { base_url: 'http://10.0.0.5/v1' },
    });
    expect(parsed.success).toBe(false);
  });
});
