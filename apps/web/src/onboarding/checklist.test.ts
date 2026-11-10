import { describe, expect, it } from 'vitest';
import { KEY_PLACEHOLDER, MODEL_PLACEHOLDER, buildSnippet, checklistSteps, currentStep } from './checklist';

const none = { credential: false, model: false, apiKey: false, firstRequest: false };

describe('checklistSteps', () => {
  it('marks nothing done for a brand-new team and opens the first step', () => {
    const steps = checklistSteps(none);
    expect(steps.map((s) => s.done)).toEqual([false, false, false, false]);
    expect(currentStep(steps)).toBe('credential');
  });

  it('judges each step on its own fact, so SDK-only traces still tick the last step', () => {
    const steps = checklistSteps({ ...none, firstRequest: true });
    expect(steps.find((s) => s.id === 'firstRequest')?.done).toBe(true);
    expect(currentStep(steps)).toBe('credential');
  });

  it('returns null as the current step once everything is done', () => {
    const steps = checklistSteps({ credential: true, model: true, apiKey: true, firstRequest: true });
    expect(currentStep(steps)).toBeNull();
  });
});

describe('buildSnippet', () => {
  const base = 'https://acruxcore.com/api/v1/';

  it('fills in the key, model and base URL when all are known', () => {
    const s = buildSnippet('curl', { baseUrl: base, apiKey: 'acx_sk_abc', model: 'support-model' });
    expect(s).toContain('https://acruxcore.com/api/v1/gateway/chat/completions');
    expect(s).toContain('Bearer acx_sk_abc');
    expect(s).toContain('"model": "support-model"');
  });

  it('falls back to placeholders when the key or model is unknown', () => {
    for (const lang of ['curl', 'python', 'node'] as const) {
      const s = buildSnippet(lang, { baseUrl: base, apiKey: null, model: null });
      expect(s).toContain(KEY_PLACEHOLDER);
      expect(s).toContain(MODEL_PLACEHOLDER);
    }
  });

  it('passes the key to each SDK by its own option name', () => {
    const values = { baseUrl: base, apiKey: 'k', model: 'm' };
    expect(buildSnippet('python', values)).toContain('AcruxCore(api_key="k", base_url="https://acruxcore.com/api/v1")');
    expect(buildSnippet('node', values)).toContain("new AcruxCore({ apiKey: 'k', baseUrl: 'https://acruxcore.com/api/v1' })");
  });
});
