import { randomBytes, createHash } from 'node:crypto';

/**
 * Generates a new virtual-key credential: a high-entropy random token, its
 * sha256 hash (what we persist), and the last four chars (for masked display).
 * The token is returned only here and shown to the caller exactly once.
 *
 * @returns `{ token, hash, lastFour }` — `token` is the plaintext `agh_sk_…`
 *   secret, `hash` is sha256(token) as hex, `lastFour` is the token's last 4 chars.
 */
export function generateKey(): { token: string; hash: string; lastFour: string } {
  const token = 'agh_sk_' + randomBytes(30).toString('base64url'); // ~47 chars
  const hash = createHash('sha256').update(token).digest('hex');
  return { token, hash, lastFour: token.slice(-4) };
}

/**
 * Hashes a presented token for constant-shape lookup against `virtual_keys.key_hash`.
 * SHA-256 (not bcrypt) is intentional: the token is already high-entropy random,
 * so a fast hash gives a cheap per-request lookup without a KDF cost (FAQ Q6).
 *
 * @param token - The plaintext bearer token presented by the caller.
 * @returns The sha256 hash of `token` as a lowercase hex string.
 */
export function hashKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
