import { describe, it, expect } from 'vitest';
import { buildPrefillFromSpan, resolveModelPublicName } from './playground-prefill';

describe('buildPrefillFromSpan', () => {
  it('prefers prompt lineage', () => {
    const p = buildPrefillFromSpan({ promptVersionId: 'v1', model: 'gpt', payload: { variables: { a: 1 } } } as never);
    expect(p).toEqual({ model: 'gpt', promptVersionId: 'v1', variables: { a: 1 } });
  });
  it('falls back to captured messages', () => {
    const p = buildPrefillFromSpan({ model: 'gpt', payload: { input: [{ role: 'user', content: 'hi' }] } } as never);
    expect(p).toEqual({ model: 'gpt', messages: [{ role: 'user', content: 'hi' }] });
  });
  it('model-only when nothing captured', () => {
    expect(buildPrefillFromSpan({ model: 'gpt' } as never)).toEqual({ model: 'gpt' });
  });
});

describe('resolveModelPublicName', () => {
  const models = [
    { publicName: 'Mimo', upstreamModel: 'xiaomi/mimo-v2.5-20260422' },
    { publicName: 'GPT', upstreamModel: 'gpt-4o-mini' },
  ];

  it('resolves an upstream model string to its publicName (the trace case)', () => {
    expect(resolveModelPublicName('xiaomi/mimo-v2.5-20260422', models)).toBe('Mimo');
  });

  it('resolves a value that is already a publicName', () => {
    expect(resolveModelPublicName('Mimo', models)).toBe('Mimo');
  });

  it('prefers a publicName match over an upstreamModel match', () => {
    const shadowed = [
      { publicName: 'shared', upstreamModel: 'other' },
      { publicName: 'other-name', upstreamModel: 'shared' },
    ];
    expect(resolveModelPublicName('shared', shadowed)).toBe('shared');
  });

  it('returns null when nothing matches (deployment renamed/deleted)', () => {
    expect(resolveModelPublicName('gone', models)).toBeNull();
  });
});
