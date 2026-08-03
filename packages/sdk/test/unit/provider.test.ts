import { describe, it, expect } from 'vitest';
import { inferProviderName } from '../../src/provider';

describe('inferProviderName', () => {
  it.each([
    ['https://api.groq.com/openai/v1', 'api.groq.com'],
    ['https://api.openai.com/v1', 'api.openai.com'],
    ['https://api.together.xyz/v1', 'api.together.xyz'],
    ['http://localhost:8000/v1', 'localhost'],
    ['http://127.0.0.1:11434/v1', '127.0.0.1'],
    ['https://my-proxy.internal.company.com/v1', 'my-proxy.internal.company.com'],
  ])('infers %s -> %s', (baseUrl, expected) => {
    expect(inferProviderName(baseUrl)).toBe(expected);
  });
});
