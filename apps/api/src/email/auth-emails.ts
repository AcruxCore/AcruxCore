import { createHash } from 'node:crypto';
import { AuthRepository } from '../auth/auth.repository';
import { EmailRepository } from './email.repository';
import { EmailService } from './email.service';
import { isEmailDisabled } from './email.config';
import { appLink } from './email.service';
import type { EmailPayload } from './email.types';

/**
 * Lifetime of a verification or reset link, in seconds.
 *
 * Exported so `better-auth.ts` configures the real token expiry from the same
 * constant the email copy quotes. Two independent values would drift, and the
 * first person to notice would be someone whose link died early.
 */
export const AUTH_LINK_TTL_SECONDS = 60 * 60;

/** The same value in minutes, for body copy. */
const TTL_MINUTES = AUTH_LINK_TTL_SECONDS / 60;

const authRepo = new AuthRepository();
const emailService = new EmailService(new EmailRepository());

/**
 * Enqueues one account-security email.
 *
 * `email_log.team_id` is NOT NULL (it is what scopes the log for RLS), but an
 * account-security email belongs to a *person*, not a team. It is attributed to
 * the user's own team, and `ensurePersonalTeam` guarantees one exists even if the
 * signup hook that normally creates it failed — otherwise a half-created account
 * could never receive the very email needed to finish setting it up.
 *
 * The dedupe key deliberately includes a coarse time bucket. Better Auth mints a
 * fresh token on every request, so a purely user-scoped key would suppress the
 * second link a person asks for after losing the first — while no bucket at all
 * would let a held-down button mail them ten times.
 */
async function enqueueAuthEmail(params: {
  userId: string;
  email: string;
  url: string;
  type: 'verify_email' | 'password_reset';
}): Promise<void> {
  const team = await authRepo.ensurePersonalTeam(params.userId, params.email);
  const bucket = Math.floor(Date.now() / 60_000);

  const payload: EmailPayload =
    params.type === 'verify_email'
      ? { type: 'verify_email', props: { url: params.url, expiresInMinutes: TTL_MINUTES } }
      : { type: 'password_reset', props: { url: params.url, expiresInMinutes: TTL_MINUTES } };

  await emailService.enqueue({
    teamId: team.id,
    to: params.email,
    dedupeKey: `${params.type}:${params.userId}:${bucket}`,
    payload,
  });
}

/**
 * Sends the "confirm your email address" email.
 *
 * A throw here would fail the signup request that triggered it, so failures are
 * logged and swallowed: the account exists and is valid, and the person can ask
 * for another link. On a no-email deployment this is never reached, because
 * accounts are created already verified.
 *
 * @param params - The new user's id and address, plus Better Auth's absolute
 *   single-use verification URL.
 */
export async function sendVerifyEmail(params: {
  userId: string;
  email: string;
  url: string;
}): Promise<void> {
  if (isEmailDisabled()) return;
  try {
    await enqueueAuthEmail({ ...params, type: 'verify_email' });
  } catch (err) {
    console.error(
      `[auth-emails] failed to enqueue verification email for user ${params.userId}`,
      err,
    );
  }
}

/**
 * Sends the password-reset email.
 *
 * Failures are logged and swallowed for a second reason beyond the one above:
 * the request endpoint answers identically whether or not the address has an
 * account, and a 500 here would break that — turning a delivery hiccup into an
 * oracle for which addresses are registered.
 *
 * @param params - The user's id and address, plus Better Auth's absolute
 *   single-use reset URL.
 */
export async function sendPasswordResetEmail(params: {
  userId: string;
  email: string;
  url: string;
}): Promise<void> {
  if (isEmailDisabled()) return;
  try {
    await enqueueAuthEmail({ ...params, type: 'password_reset' });
  } catch (err) {
    console.error(
      `[auth-emails] failed to enqueue reset email for user ${params.userId}`,
      err,
    );
  }
}

/**
 * Enqueues one email that is attributed to a user's own team but carries no
 * unsubscribe link, because it reports a change to their account rather than an
 * activity they can opt out of.
 *
 * @param params - Recipient identity, a dedupe key, and the rendered payload.
 */
async function enqueueAccountEmail(params: {
  userId: string;
  email: string;
  dedupeKey: string;
  payload: EmailPayload;
}): Promise<void> {
  const team = await authRepo.ensurePersonalTeam(params.userId, params.email);
  await emailService.enqueue({
    teamId: team.id,
    to: params.email,
    dedupeKey: params.dedupeKey,
    payload: params.payload,
  });
}

/**
 * Sends the welcome email, once, after an address is confirmed.
 *
 * Keyed on the user id with no time bucket, so a person who somehow verifies
 * twice is welcomed once. Failures are swallowed: a missing welcome email is a
 * cosmetic loss, and throwing would fail the verification request that produced
 * it — turning a nicety into a broken signup.
 *
 * @param params - The freshly verified user's id and address.
 */
export async function sendWelcomeEmail(params: {
  userId: string;
  email: string;
}): Promise<void> {
  if (isEmailDisabled()) return;
  try {
    const team = await authRepo.ensurePersonalTeam(params.userId, params.email);
    await emailService.enqueue({
      teamId: team.id,
      to: params.email,
      dedupeKey: `welcome:${params.userId}`,
      payload: {
        type: 'welcome',
        props: { dashboardUrl: appLink('/prompts'), teamName: team.name },
      },
    });
  } catch (err) {
    console.error(`[auth-emails] failed to enqueue welcome email for ${params.userId}`, err);
  }
}

/**
 * Sends the "your password was changed" confirmation.
 *
 * Unconditional — no preference suppresses it. This is the message that tells
 * someone their account was taken over, and a user who had turned off
 * "notifications" would be exactly the user who never finds out.
 *
 * @param params - The user's id and address.
 */
export async function sendPasswordChangedEmail(params: {
  userId: string;
  email: string;
}): Promise<void> {
  if (isEmailDisabled()) return;
  try {
    // Bucketed by the minute: a reset is a discrete event, but a retried request
    // must not produce a second copy.
    const bucket = Math.floor(Date.now() / 60_000);
    await enqueueAccountEmail({
      ...params,
      dedupeKey: `password_changed:${params.userId}:${bucket}`,
      payload: {
        type: 'password_changed',
        props: { changedAt: new Date().toISOString(), resetUrl: appLink('/reset-password') },
      },
    });
  } catch (err) {
    console.error(`[auth-emails] failed to enqueue password-changed email for ${params.userId}`, err);
  }
}

/**
 * Fingerprints a sign-in's device.
 *
 * Hashed so the long-lived `known_devices` table never holds a raw IP; the
 * plaintext values are used once, inside the email body, and then discarded.
 *
 * @param ip - Requesting IP, or null.
 * @param userAgent - Client user-agent, or null.
 * @returns A stable hex digest for this (ip, agent) pair.
 */
function deviceFingerprint(ip: string | null, userAgent: string | null): string {
  return createHash('sha256').update(`${ip ?? ''}|${userAgent ?? ''}`).digest('hex');
}

/**
 * Records the device behind a new session and alerts the user if it is new to
 * this account.
 *
 * The very first device is recorded silently: it is the signup itself, which the
 * verification and welcome emails already cover, and "you signed in" arriving
 * seconds after "welcome" reads like a bug.
 *
 * @param params - The session's user, address, IP, and user-agent.
 */
export async function recordSignInDevice(params: {
  userId: string;
  email: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<void> {
  const fingerprint = deviceFingerprint(params.ipAddress, params.userAgent);
  try {
    const isNewDevice = await authRepo.recordDeviceAndDetectNew(params.userId, fingerprint);

    if (!isNewDevice || isEmailDisabled()) return;

    await enqueueAccountEmail({
      userId: params.userId,
      email: params.email,
      dedupeKey: `new_sign_in:${params.userId}:${fingerprint.slice(0, 16)}`,
      payload: {
        type: 'new_sign_in',
        props: {
          signedInAt: new Date().toISOString(),
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
          resetUrl: appLink('/reset-password'),
        },
      },
    });
  } catch (err) {
    // Never fail a sign-in over telemetry about that sign-in.
    console.error(`[auth-emails] failed to record device for ${params.userId}`, err);
  }
}
