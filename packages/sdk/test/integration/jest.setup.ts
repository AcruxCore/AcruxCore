import path from 'path';
import dotenv from 'dotenv';

/**
 * Integration tests boot the real `apps/api` Express app + Prisma client against
 * a real Postgres database (per this repo's testing philosophy — no mocked DB).
 * `apps/api`'s own tests get `DATABASE_URL`/`TEST_DATABASE_URL` "for free" because
 * Prisma's runtime auto-discovers a `.env` file by walking up from `process.cwd()`.
 *
 * `packages/sdk`'s integration suite runs with `cwd === packages/sdk`, a sibling
 * (not an ancestor) of the `.env`'s directory, so that upward walk never finds it and
 * `apps/api/src/shared/db/client.ts` throws at import time. Load it explicitly here
 * instead of relying on cwd auto-discovery.
 *
 * The path is the REPO ROOT, not `apps/api/.env`: this pointed at `apps/api/.env` for
 * a long time after that file moved, which made the call a silent no-op — dotenv does
 * not complain about a missing file. It only kept working because a developer's shell
 * happened to export the same variables.
 */
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

/**
 * Auth defaults these suites need, mirroring `apps/api/src/test-utils/jest-env.ts`.
 *
 * Assigned unconditionally rather than with `??=`, which is what that file uses. The
 * repo's `.env` sets `AUTH_REQUIRE_EMAIL_VERIFICATION=` (an EMPTY string) and
 * `NODE_ENV=development`, and `??=` treats an empty string as already-set. The result
 * was `auth.config` deriving "verification required" from `EMAIL_TRANSPORT=smtp`,
 * Better Auth withholding the session on signup, and every suite failing at setup with
 * "No session cookie in response". Forcing the values here makes the suite independent
 * of whatever the shell exports.
 */
process.env.NODE_ENV = 'test';
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'false';
process.env.BETTER_AUTH_SECRET ||= 'test-only-better-auth-secret-not-a-real-one';

// Forcing NODE_ENV=test above is also what points Prisma at TEST_DATABASE_URL rather
// than the dev database — `apps/api/src/shared/db/client.ts` selects on it. That matters
// here because these suites TRUNCATE tables.
