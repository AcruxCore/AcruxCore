import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** What an unsubscribe token addresses: one category, for one user, in one team. */
export interface UnsubscribeClaims {
  userId: string;
  teamId: string;
  /** A `NotificationCategory` value. Kept as a string here so this module has no
   *  dependency on the notifications domain — verification does not need to know
   *  which categories exist, only that the string was signed by us. */
  category: string;
}

/** Separator between claim fields in the signed message. */
const SEP = ':';

let devSecret: Buffer | null = null;

/**
 * Loads the HMAC key from `EMAIL_UNSUBSCRIBE_SECRET` (base64, 32 bytes).
 *
 * Outside production a missing value falls back to a **random per-process**
 * key rather than a fixed development default. A predictable key would make
 * every unsubscribe token forgeable by anyone who read the source, which is the
 * one thing this token must not be. The cost is that links minted before a
 * local restart stop verifying — fine locally, and impossible in production
 * where the var is required.
 *
 * @returns The raw 32-byte key.
 * @throws {Error} In production, when the var is unset or not 32 bytes.
 */
function unsubscribeKey(): Buffer {
  const b64 = process.env.EMAIL_UNSUBSCRIBE_SECRET;
  if (!b64) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('EMAIL_UNSUBSCRIBE_SECRET is not set');
    }
    if (!devSecret) devSecret = randomBytes(32);
    return devSecret;
  }
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error('EMAIL_UNSUBSCRIBE_SECRET must be 32 bytes (base64)');
  }
  return key;
}

/**
 * Validates the unsubscribe key at startup, so a production process missing it
 * crashes immediately instead of mailing links that cannot be honoured.
 *
 * @throws {Error} When `EMAIL_UNSUBSCRIBE_SECRET` is required and invalid.
 */
export function assertUnsubscribeSecret(): void {
  unsubscribeKey();
}

/** The signed message. A fixed field order, joined by a character no field contains. */
function message(claims: UnsubscribeClaims): string {
  return [claims.userId, claims.teamId, claims.category].join(SEP);
}

function sign(msg: string): Buffer {
  return createHmac('sha256', unsubscribeKey()).update(msg).digest();
}

/**
 * Mints a self-authenticating unsubscribe token.
 *
 * An HMAC rather than a stored row: there is no state worth persisting — the
 * token encodes exactly the three facts needed to write one preference row — it
 * cannot be produced without the secret, and it needs no cleanup job.
 *
 * It deliberately **never expires**. An unsubscribe link in a months-old email
 * must still work; that is the entire point of RFC 8058's header.
 *
 * @param claims - The user, team, and category the token addresses.
 * @returns `base64url(payload).base64url(hmac)`, safe in a URL query string.
 * @throws {Error} When the signing key is missing or malformed (production only).
 */
export function mintUnsubscribeToken(claims: UnsubscribeClaims): string {
  const msg = message(claims);
  const payload = Buffer.from(msg, 'utf8').toString('base64url');
  return `${payload}.${sign(msg).toString('base64url')}`;
}

/**
 * Verifies a token and returns the claims it carries.
 *
 * The signature is compared with {@link timingSafeEqual}, so a caller cannot
 * learn how much of a guessed HMAC was correct from how long the comparison
 * took. Every failure mode — malformed shape, undecodable payload, wrong field
 * count, bad signature — returns `null` rather than throwing or distinguishing
 * itself, so the endpoint above cannot be used as an oracle.
 *
 * @param token - Untrusted value from the query string.
 * @returns The claims, or null when the token is not one we minted.
 */
export function verifyUnsubscribeToken(token: string | undefined): UnsubscribeClaims | null {
  if (!token) return null;

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;

  const payload = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1), 'base64url');
  // A length mismatch would make timingSafeEqual throw, so it is checked first.
  // Length is not secret — a wrong-length HMAC is wrong regardless.
  if (provided.length !== 32) return null;

  const msg = Buffer.from(payload, 'base64url').toString('utf8');

  let expected: Buffer;
  try {
    expected = sign(msg);
  } catch {
    // A missing/invalid secret in production: reject rather than 500, so the
    // endpoint's response stays uniform, and let the boot assertion be the
    // place that surfaces a misconfiguration.
    return null;
  }

  if (!timingSafeEqual(expected, provided)) return null;

  const parts = msg.split(SEP);
  if (parts.length !== 3) return null;
  const [userId, teamId, category] = parts;
  if (!userId || !teamId || !category) return null;

  return { userId, teamId, category };
}
