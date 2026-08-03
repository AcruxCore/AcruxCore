import { createHash } from 'node:crypto';
import { generateKey, hashKey, API_KEY_PREFIX } from './api-keys.crypto';

describe('api-keys.crypto', () => {
  it('generateKey returns a prefixed token whose hash and lastFour match the token', () => {
    const { token, hash, lastFour } = generateKey();

    expect(token.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(token.length).toBeGreaterThan(40);
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(lastFour).toBe(token.slice(-4));
  });

  it('generateKey never repeats a token', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateKey().token));
    expect(tokens.size).toBe(200);
  });

  it('hashKey is deterministic and differs per token', () => {
    const a = generateKey().token;
    const b = generateKey().token;

    expect(hashKey(a)).toBe(hashKey(a));
    expect(hashKey(a)).not.toBe(hashKey(b));
  });

  it('hashKey never returns the token itself', () => {
    const { token } = generateKey();
    expect(hashKey(token)).not.toContain(token);
  });
});
