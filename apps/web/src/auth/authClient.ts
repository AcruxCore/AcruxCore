import { createAuthClient } from 'better-auth/react';
import { inferAdditionalFields } from 'better-auth/client/plugins';

/**
 * The browser-side Better Auth client.
 *
 * Owns sign-up, sign-in, sign-out, Google, verification, and password reset.
 * Unlike the Supabase client it replaced, it stores **nothing**: the session is
 * an httpOnly cookie the browser attaches automatically and no script — ours or
 * an injected one — can read it. There is consequently no token to refresh, no
 * `onAuthStateChange` to subscribe to, and no `localStorage` entry to keep in
 * sync; the API's `/auth/me` is the single source of truth for "am I signed in".
 *
 * `baseURL` is the page's own origin because web and API are always same-origin:
 * nginx proxies `/api` in production, and Vite proxies it in dev. That is also
 * what lets the cookie be `SameSite=Lax` rather than a cross-site cookie.
 */
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/v1/auth',
  plugins: [
    // Types `marketingConsent` on `signUp.email(...)`. The schema is
    // declared manually (not `inferAdditionalFields<typeof auth>()`) because
    // the web app cannot import the API's server-only Better Auth instance
    // into its browser bundle. `required` and `defaultValue` are deliberately
    // mirrored from the server (apps/api/src/shared/auth/better-auth.ts:88-93)
    // to keep the client/server contract in sync. `termsAcceptedAt` is server-only
    // (`input: false`) and deliberately omitted here — the client never
    // sends or reads it.
    inferAdditionalFields({
      user: {
        marketingConsent: { type: 'boolean', required: false, defaultValue: false },
      },
    }),
  ],
});

/**
 * Turns a Better Auth error into a line worth showing a person.
 *
 * Its codes are stable, so this maps on `code` and falls back to the message —
 * the Supabase version had to substring-match English prose, which broke on any
 * upstream copy change.
 *
 * @param error - The `error` object from any `authClient` call.
 * @returns A user-facing message.
 */
export function mapAuthError(
  error: { code?: string; message?: string; status?: number } | null | undefined,
): string {
  if (!error) return 'Something went wrong. Please try again.';

  switch (error.code) {
    case 'INVALID_EMAIL_OR_PASSWORD':
      return 'Wrong email or password.';
    case 'EMAIL_NOT_VERIFIED':
      return 'Please confirm your email first — check your inbox for the verification link.';
    case 'USER_ALREADY_EXISTS':
    case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL':
      return 'An account with this email already exists. Try signing in instead.';
    case 'PASSWORD_TOO_SHORT':
      return 'Use at least 8 characters.';
    case 'INVALID_TOKEN':
    case 'TOKEN_EXPIRED':
      return 'That link is no longer valid. Request a new one.';
    default:
      break;
  }

  if (error.status === 429) {
    return 'Too many attempts. Wait a minute and try again.';
  }
  return error.message || 'Something went wrong. Please try again.';
}
