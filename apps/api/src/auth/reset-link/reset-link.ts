import { getAuth } from '../../shared/auth/better-auth';
import { AuthRepository } from '../auth.repository';

const authRepo = new AuthRepository();

/**
 * Addresses currently awaiting an intercepted reset link, with the resolver that
 * is waiting for it.
 *
 * Keyed by email because that is all `sendResetPassword` receives that the caller
 * also knows. Entries live for milliseconds — between calling `forgetPassword`
 * and Better Auth invoking the send hook — and are always removed, on both the
 * success and timeout paths.
 */
const pending = new Map<string, (url: string) => void>();

/** How long to wait for Better Auth to hand the link to the send hook. */
const CAPTURE_TIMEOUT_MS = 10_000;

/**
 * Diverts a reset link to a waiting caller instead of emailing it.
 *
 * Called from Better Auth's `sendResetPassword` hook.
 *
 * @param email - The account the link is for.
 * @param url - The absolute, single-use reset URL.
 * @returns True when the link was handed to a waiting caller and must NOT be
 *   emailed; false when no one is waiting and normal delivery should proceed.
 */
export function deliverToCapture(email: string, url: string): boolean {
  const resolve = pending.get(email);
  if (!resolve) return false;
  pending.delete(email);
  resolve(url);
  return true;
}

/**
 * Produces a password-reset link for an account without sending any email.
 *
 * Reuses Better Auth's real `requestPasswordReset` flow and intercepts the resulting
 * URL, rather than minting a token by hand. That matters: the link is written to
 * `auth_verifications` by the same code that consumes it, so it expires and
 * single-uses exactly like an emailed one. A hand-rolled token would be a second
 * implementation of the most security-sensitive path in the app.
 *
 * This is the escape hatch for `EMAIL_TRANSPORT=none`: an operator or admin gets
 * the link and delivers it by whatever channel they actually have.
 *
 * Works for a Google-only account too: Better Auth's reset flow creates the
 * missing `credential` row when the link is used, so this is also how such an
 * owner gains a password.
 *
 * @param email - The account to produce a link for.
 * @returns The absolute reset URL, or null when the address has no account or
 *   the link was not produced within {@link CAPTURE_TIMEOUT_MS}.
 */
export async function mintResetLink(email: string): Promise<string | null> {
  // Checked up front rather than waited out. There is no enumeration concern on
  // this path — the caller is an operator at a shell or an admin already inside
  // the team — and without it an unknown address costs the full capture timeout.
  const exists = await authRepo.findUserByEmail(email);
  if (!exists) return null;

  const captured = new Promise<string | null>((resolve) => {
    pending.set(email, resolve);
    setTimeout(() => {
      // Nobody delivered: unknown address, social-only account, or a hook error.
      if (pending.delete(email)) resolve(null);
    }, CAPTURE_TIMEOUT_MS).unref?.();
  });

  // Better Auth answers 200 for an unknown address by design (no enumeration),
  // so the response tells us nothing — only the capture does.
  await getAuth().api.requestPasswordReset({
    body: { email, redirectTo: '/reset-password' },
  });

  return captured;
}
