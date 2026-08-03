import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

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
