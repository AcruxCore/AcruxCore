import { describe, expect, it } from 'vitest';
import { isUuid } from '../../src/refs';
import { normalizeBaseUrl } from '../../src/client';
import { toPromptMessages } from '../../src/registry-prompts';

describe('isUuid', () => {
  it('accepts a real id and tolerates surrounding whitespace', () => {
    expect(isUuid('5fd454e0-bdb2-4468-b369-7fbb3f252dca')).toBe(true);
    expect(isUuid('  5fd454e0-bdb2-4468-b369-7fbb3f252dca ')).toBe(true);
  });

  it('rejects prompt names, including ones with hyphens', () => {
    expect(isUuid('customer-support')).toBe(false);
    expect(isUuid('5fd454e0-bdb2-4468-b369')).toBe(false);
  });
});

describe('normalizeBaseUrl', () => {
  it('appends the version prefix when the user pasted a bare host', () => {
    expect(normalizeBaseUrl('https://api.acruxcore.com')).toBe('https://api.acruxcore.com/api/v1');
    expect(normalizeBaseUrl('http://localhost:3000/')).toBe('http://localhost:3000/api/v1');
  });

  it('leaves a URL that already carries one alone', () => {
    expect(normalizeBaseUrl('https://api.acruxcore.com/api/v1')).toBe(
      'https://api.acruxcore.com/api/v1',
    );
    expect(normalizeBaseUrl('https://api.acruxcore.com/api/v1/')).toBe(
      'https://api.acruxcore.com/api/v1',
    );
  });
});

describe('toPromptMessages', () => {
  it('carries a system message through as the leading user message, text unchanged', () => {
    const messages = toPromptMessages([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'Hello.' },
    ]);

    // MCP has no system role, so dropping it would silently change what the prompt does.
    expect(messages[0]).toEqual({ role: 'user', content: { type: 'text', text: 'You are terse.' } });
    expect(messages[1].role).toBe('user');
  });

  it('preserves assistant turns', () => {
    const messages = toPromptMessages([{ role: 'assistant', content: 'Sure.' }]);
    expect(messages[0].role).toBe('assistant');
  });

  it('serialises non-string content rather than emitting undefined', () => {
    const messages = toPromptMessages([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    expect((messages[0].content as { text: string }).text).toContain('hi');
  });
});
