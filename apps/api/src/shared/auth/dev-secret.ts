import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * File name of the generated development signing secret, created in the API's
 * working directory (`apps/api` under `npm run dev`, `/app` in the image) and
 * listed in `.gitignore`.
 */
export const DEV_SECRET_FILE_NAME = '.better-auth-dev-secret';

/** Shortest file content accepted as a secret; anything less is regenerated. */
const MIN_SECRET_LENGTH = 32;

/** A fresh 256-bit secret, URL-safe so it survives any copy-paste. */
function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** The trimmed file content, or `null` when it is too short to be a secret. */
function readSecret(filePath: string): string | null {
  const value = readFileSync(filePath, 'utf8').trim();
  return value.length >= MIN_SECRET_LENGTH ? value : null;
}

/**
 * Returns this machine's development signing secret, generating it on first use.
 *
 * Why a file and not a constant: Better Auth signs self-authenticating tokens
 * with its secret (a `/verify-email` JWT signs its holder in), so a value in the
 * public repository would let anyone mint a session for any user. Why a file and
 * not a per-process random value: `tsx watch` restarts the API on every save,
 * and a new secret per restart would sign every developer out each time.
 *
 * The file is created with `wx` (fail if it exists) and mode 0600, so two API
 * processes booting together in one directory agree on one value: the loser of
 * the race reads the winner's file.
 *
 * @param filePath - Absolute path of the secret file. Its directory must exist.
 * @returns The persisted secret, or — when the file cannot be read or written
 *   (read-only filesystem, no permission) — a random value for this process
 *   only, after a warning. Sessions then end when the process restarts, which is
 *   the safe way to fail.
 */
export function loadOrCreateDevSecret(filePath: string): string {
  try {
    const existing = readSecret(filePath);
    if (existing) return existing;
    // Too short to trust (an empty or truncated file): replace it.
    const replacement = generateSecret();
    writeFileSync(filePath, `${replacement}\n`, { mode: 0o600 });
    return replacement;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return processOnlySecret(filePath, err);
  }

  const created = generateSecret();
  try {
    writeFileSync(filePath, `${created}\n`, { flag: 'wx', mode: 0o600 });
    return created;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        const winner = readSecret(filePath);
        if (winner) return winner;
      } catch (readErr) {
        return processOnlySecret(filePath, readErr);
      }
    }
    return processOnlySecret(filePath, err);
  }
}

/** Logs why the file could not be used and returns a secret for this process only. */
function processOnlySecret(filePath: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  console.warn(
    `[auth] Could not persist a development BETTER_AUTH_SECRET at ${filePath} (${reason}); ` +
      'using a random one for this process, so sessions end when it restarts. ' +
      'Set BETTER_AUTH_SECRET to keep them.',
  );
  return generateSecret();
}
