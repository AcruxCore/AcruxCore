import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadAuthConfig } from '../../shared/auth/auth.config';

/** How long a printed claim URL stays valid. */
export const CLAIM_TTL_MS = 60 * 60 * 1000;

/** Prefix in the signed message, so this token can never be confused for another. */
const PURPOSE = 'first-run-claim';

/**
 * Derives the claim-signing key.
 *
 * A separate HMAC key rather than the raw secret, so a claim token and a session
 * cookie can never be substituted for one another even though both are signed by
 * this process. The input is `claimSecret`, not `secret`: this token is verified
 * against nothing but its own signature, so it must never be signed by the
 * publicly known development fallback.
 *
 * @returns The derived key.
 */
function claimKey(): Buffer {
  return createHmac('sha256', loadAuthConfig().claimSecret).update(PURPOSE).digest();
}

/** The signed message: purpose plus the absolute expiry, in milliseconds. */
function message(expiresAt: number): string {
  return `${PURPOSE}:${expiresAt}`;
}

/**
 * Mints a first-run claim token.
 *
 * Deliberately carries no identity: it authorizes "create the first account on
 * this instance", and *which* account is whatever the person who opens the link
 * chooses. Nothing is stored — single use comes from the `users` table being
 * empty, a condition a successful claim destroys.
 *
 * @param now - Current epoch milliseconds, injected so tests need no clock control.
 * @returns The token string, safe for a URL query parameter.
 */
export function mintClaimToken(now: number = Date.now()): string {
  const expiresAt = now + CLAIM_TTL_MS;
  const payload = Buffer.from(String(expiresAt)).toString('base64url');
  const sig = createHmac('sha256', claimKey()).update(message(expiresAt)).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * Verifies a claim token's signature and expiry.
 *
 * Returns a plain boolean, never a reason. A caller that distinguished "expired"
 * from "forged" would tell an attacker which half of the token to work on.
 *
 * @param token - The value from the claim URL.
 * @param now - Current epoch milliseconds.
 * @returns True only when the token is well-formed, correctly signed, and unexpired.
 */
export function verifyClaimToken(token: string, now: number = Date.now()): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;

  const expiresAt = Number(Buffer.from(payload, 'base64url').toString());
  if (!Number.isFinite(expiresAt)) return false;

  const expected = createHmac('sha256', claimKey())
    .update(message(expiresAt))
    .digest('base64url');

  // Compare lengths first: timingSafeEqual throws on a mismatch rather than
  // returning false, which would surface as a 500 for any malformed token.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  return now < expiresAt;
}
