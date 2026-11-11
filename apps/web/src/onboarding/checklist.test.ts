import { describe, expect, it } from 'vitest';
import { KEY_PLACEHOLDER, MODEL_PLACEHOLDER, buildDirectSnippet, buildSnippet, buildToolSnippet, checklistSteps, currentStep, resolvePath, stepNumber } from './checklist';

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

describe('setup paths', () => {
  it('gives the direct path only the key and first-trace steps, numbered 1 and 2', () => {
    const steps = checklistSteps({ ...none, apiKey: true }, 'direct');
    expect(steps.map((s) => s.id)).toEqual(['apiKey', 'firstRequest']);
    expect(currentStep(steps)).toBe('firstRequest');
    expect(stepNumber('firstRequest', 'direct')).toBe(2);
    expect(stepNumber('firstRequest', 'gateway')).toBe(4);
  });

  it('finishes the direct path from a key and a trace, with no credential or model', () => {
    const steps = checklistSteps({ ...none, apiKey: true, firstRequest: true }, 'direct');
    expect(currentStep(steps)).toBeNull();
  });

  it('infers the direct path for a team with traces and no credential, unless the viewer chose', () => {
    expect(resolvePath({ ...none, firstRequest: true }, null)).toBe('direct');
    expect(resolvePath({ ...none, credential: true, firstRequest: true }, null)).toBe('gateway');
    expect(resolvePath(none, null)).toBe('gateway');
    expect(resolvePath({ ...none, firstRequest: true }, 'gateway')).toBe('gateway');
  });
});

describe('buildDirectSnippet', () => {
  const values = { baseUrl: 'https://acruxcore.com/api/v1', apiKey: 'acx_sk_abc', model: null };

  it('passes each provider to the SDK the way that provider needs', () => {
    expect(buildDirectSnippet('python', 'anthropic', values)).toContain('provider = {"kind": "anthropic", "api_key": os.environ["ANTHROPIC_API_KEY"]}');
    expect(buildDirectSnippet('python', 'openrouter', values)).toContain('"base_url": "https://openrouter.ai/api/v1"');
    expect(buildDirectSnippet('node', 'gemini', values)).toContain("provider: { kind: 'gemini', apiKey: process.env.GEMINI_API_KEY }");
    expect(buildDirectSnippet('node', 'openai', values)).toContain("baseUrl: 'https://api.openai.com/v1'");
  });

  it('carries the AcruxCore key, never a provider key', () => {
    const s = buildDirectSnippet('python', 'openai', values);
    expect(s).toContain('AcruxCore(api_key="acx_sk_abc", base_url="https://acruxcore.com/api/v1", provider=provider)');
    expect(buildDirectSnippet('node', 'openai', { ...values, apiKey: null })).toContain(KEY_PLACEHOLDER);
  });
});

describe('buildToolSnippet', () => {
  const values = { baseUrl: 'https://acruxcore.com/api/v1', apiKey: 'acx_sk_1', model: 'support-model' };

  it('defines the tool with the decorator and passes it to the tool loop, in both languages', () => {
    const py = buildToolSnippet('python', 'gateway', 'openai', values);
    expect(py).toContain('@acrux.tool');
    expect(py).toContain('tools=[get_weather]');
    expect(py).toContain('from acruxcore import AcruxCore, acrux');
    const node = buildToolSnippet('node', 'gateway', 'openai', values);
    expect(node).toContain('acrux.tool(');
    expect(node).toContain("from 'zod/v4'");
    expect(node).toContain('tools: [getWeather]');
    expect(node).toContain('npm install @acruxcoreai/sdk zod');
  });

  it('calls the team model through the gateway, with no provider setting', () => {
    const py = buildToolSnippet('python', 'gateway', 'anthropic', values);
    expect(py).toContain('"support-model"');
    expect(py).not.toContain('provider');
    expect(buildToolSnippet('python', 'gateway', 'openai', { ...values, model: null })).toContain(MODEL_PLACEHOLDER);
  });

  it('on the direct path, sends the provider setting and the provider model, never the team model', () => {
    const py = buildToolSnippet('python', 'direct', 'gemini', values);
    expect(py).toContain('"kind": "gemini"');
    expect(py).toContain('os.environ["GEMINI_API_KEY"]');
    expect(py).toContain('provider=provider');
    expect(py).not.toContain('support-model');
    const node = buildToolSnippet('node', 'direct', 'anthropic', values);
    expect(node).toContain("kind: 'anthropic'");
    expect(node).toContain("model: 'claude-haiku-4-5'");
  });

  it('carries a placeholder when the key is not known', () => {
    expect(buildToolSnippet('node', 'direct', 'openai', { ...values, apiKey: null })).toContain(KEY_PLACEHOLDER);
  });
});

describe('Node snippets', () => {
  it('are plain JavaScript, so `node app.mjs` runs them without a TypeScript step', () => {
    const values = { baseUrl: 'https://acruxcore.com/api/v1', apiKey: 'k', model: 'm' };
    for (const s of [buildDirectSnippet('node', 'openai', values), buildToolSnippet('node', 'direct', 'openai', values)]) {
      expect(s).not.toMatch(/!,|!\s*}|: Record</);
    }
  });
});
