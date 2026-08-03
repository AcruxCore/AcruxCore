import { createHash } from 'node:crypto';
import { generateKey, hashKey } from './keys.crypto';

describe('keys.crypto', () => {
  it('hashKey is deterministic sha256 hex of the token', () => {
    const token = 'agh_sk_example_token_value';
    const expected = createHash('sha256').update(token).digest('hex');
    expect(hashKey(token)).toBe(expected);
    expect(hashKey(token)).toBe(hashKey(token)); // deterministic
    expect(hashKey(token)).toMatch(/^[0-9a-f]{64}$/); // 64 hex chars
  });

  it('generateKey produces an agh_sk_ token whose hash and lastFour match', () => {
    const { token, hash, lastFour } = generateKey();
    expect(token.startsWith('agh_sk_')).toBe(true);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(hash).toBe(hashKey(token));
    expect(lastFour).toBe(token.slice(-4));
  });

  it('generateKey is random — two calls differ', () => {
    expect(generateKey().token).not.toBe(generateKey().token);
  });
});
