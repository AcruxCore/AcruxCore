import { randomBytes, createHash } from 'node:crypto';

/**
 * Prefix on every platform API key. Makes keys recognisable to users and
 * greppable in logs, matching the convention OpenAI and Stripe use. Gateway
 * virtual keys use their own `agh_sk_` prefix and are unrelated.
 */
export const API_KEY_PREFIX = 'acx_sk_';

/**
 * Mints a new platform API key: the plaintext token, its sha256 hash (the only
 * part that is persisted), and the last four characters for masked display.
 * The token is returned here and shown to the user exactly once — it cannot be
 * recovered from the database afterwards.
 *
 * @returns `{ token, hash, lastFour }` — `token` is the plaintext `acx_sk_…`
 *   secret, `hash` is sha256(token) as lowercase hex, `lastFour` is the token's
 *   last 4 characters.
 */
export function generateKey(): { token: string; hash: string; lastFour: string } {
  const token = API_KEY_PREFIX + randomBytes(30).toString('base64url'); // ~47 chars
  return { token, hash: hashKey(token), lastFour: token.slice(-4) };
}

/**
 * Hashes a presented token for lookup against `api_keys.key_hash`.
 *
 * SHA-256 rather than bcrypt/argon2 is intentional: the token is 240 bits of
 * CSPRNG output, so there is no low-entropy secret for a KDF to stretch, and a
 * fast hash keeps the per-request auth lookup cheap. Same reasoning as the
 * gateway's virtual keys (phase-2 FAQ Q6).
 *
 * @param token - The plaintext bearer token presented by the caller.
 * @returns The sha256 hash of `token` as a lowercase hex string.
 */
export function hashKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
