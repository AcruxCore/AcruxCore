import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CredentialUnusableError } from '../../shared/errors';

const ALGO = 'aes-256-gcm';

/**
 * Loads and validates the 32-byte master key from `GATEWAY_ENCRYPTION_KEY`
 * (base64-encoded). Called on every encrypt/decrypt so a mis-set key fails loudly.
 *
 * @returns The raw 32-byte key buffer.
 * @throws {Error} If the env var is unset or does not decode to exactly 32 bytes.
 */
function masterKey(): Buffer {
  const b64 = process.env.GATEWAY_ENCRYPTION_KEY;
  if (!b64) throw new Error('GATEWAY_ENCRYPTION_KEY is not set');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('GATEWAY_ENCRYPTION_KEY must be 32 bytes (base64)');
  return key;
}

/**
 * Validates the master key at startup so the process crashes early instead of
 * on the first gateway call. Delegates to {@link masterKey}.
 *
 * @throws {Error} If `GATEWAY_ENCRYPTION_KEY` is missing or not 32 bytes.
 */
export function assertMasterKey(): void {
  masterKey();
}

/**
 * Encrypts a plaintext secret with AES-256-GCM under the env master key.
 * A fresh random 12-byte IV is generated per call.
 *
 * @param plaintext - The provider API key (or any secret string) to encrypt.
 * @returns A packed buffer: `iv(12) || authTag(16) || ciphertext`.
 * @throws {Error} If the master key is missing or invalid.
 */
export function encryptSecret(plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/**
 * Decrypts a buffer produced by {@link encryptSecret}. The GCM auth tag is
 * verified, so any tampering or a wrong key throws rather than returning garbage.
 *
 * @param packed - The `iv(12) || authTag(16) || ciphertext` bytes from the DB.
 *   Accepts any `Uint8Array` — a Node `Buffer` or Prisma's `Bytes` column value.
 * @returns The original plaintext secret.
 * @throws {Error} If the auth tag does not verify (tampered/wrong key) or the key is invalid.
 */
export function decryptSecret(packed: Uint8Array): string {
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const ct = packed.subarray(28);
  const decipher = createDecipheriv(ALGO, masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Kind of stored secret being decrypted, used only to word the failure so the reader is
 * pointed at the screen that can fix it.
 */
export type StoredSecretKind = 'provider_credential' | 'tool_secret';

/**
 * Decrypts a stored secret, converting a decrypt failure into a typed 409 instead of an
 * unhandled crash.
 *
 * {@link decryptSecret} throws a raw `Error` from `Decipheriv.final()` when the master key
 * no longer matches the ciphertext — correct crypto behaviour, but nothing caught it, so a
 * key rotation that left a row behind surfaced as an opaque 500 on live gateway traffic
 * (issue #324). The plaintext is never included in the thrown error.
 *
 * @param packed - The `iv(12) || authTag(16) || ciphertext` bytes from the DB.
 * @param kind - Which store the secret came from, selecting the remediation wording.
 * @param label - Human-facing name of the row (a credential label, a secret key), shown to
 *   the caller so they know which one to fix. Omitted when the caller has no safe name.
 * @returns The original plaintext secret.
 * @throws {CredentialUnusableError} If the ciphertext cannot be decrypted with the current
 *   `GATEWAY_ENCRYPTION_KEY`.
 */
export function decryptStoredSecret(
  packed: Uint8Array,
  kind: StoredSecretKind,
  label?: string,
): string {
  try {
    return decryptSecret(packed);
  } catch {
    const named = label ? ` "${label}"` : '';
    throw new CredentialUnusableError(
      kind === 'provider_credential'
        ? `The stored provider credential${named} can no longer be decrypted. Reconnect it under Gateway → Credentials, then retry.`
        : `The stored secret${named} can no longer be decrypted. Re-enter it under Gateway → Secrets, then retry.`,
    );
  }
}
