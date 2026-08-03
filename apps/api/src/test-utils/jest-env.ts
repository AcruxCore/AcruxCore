/**
 * Environment defaults every suite needs, applied before any module is imported.
 *
 * Must be a `setupFiles` entry, not `setupFilesAfterEnv`: `loadAuthConfig()` and
 * `loadEmailConfig()` memoize on first read, and the first read happens when a
 * suite imports the app — which is earlier than `setupFilesAfterEnv` runs.
 *
 * `??=` throughout, so a suite that deliberately sets one of these before Jest
 * starts (or a CI job that exports a real value) still wins.
 */

// Better Auth refuses to build without a secret. Any stable value works here:
// sessions are validated against `auth_sessions` rows, so this only signs the
// tamper seal on tokens that must already exist in the test database.
process.env.BETTER_AUTH_SECRET ??= 'test-only-better-auth-secret-not-a-real-one';

// The shared `signupTestUser`/`authedAgent` helpers need signup to return a usable
// session immediately. With verification required, Better Auth deliberately
// withholds the session until the address is confirmed — correct in production,
// but it would mean every one of the ~100 suites had to walk an email flow to
// reach the feature it actually tests. The gate itself is covered explicitly in
// `src/auth/auth.test.ts`, which re-enables it for those cases.
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION ??= 'false';
