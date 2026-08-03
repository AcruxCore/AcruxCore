import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import prisma from '../db/client';
import { AuthRepository } from '../../auth/auth.repository';
import {
  AUTH_LINK_TTL_SECONDS,
  recordSignInDevice,
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
  sendVerifyEmail,
  sendWelcomeEmail,
} from '../../email/auth-emails';
// Both reach past the `auth/` barrels on purpose. Those barrels re-export
// `first-run.service` and `reset-link`, which import `getAuth` from this file —
// so importing them here would close an import cycle. The two modules named
// below are leaves (`claim-context` imports nothing but `node:async_hooks`), and
// naming them directly keeps the cycle from forming.
import { deliverToCapture } from '../../auth/reset-link/reset-link';
import { isFirstRunClaim } from '../../auth/first-run/claim-context';
import { isGoogleEnabled, loadAuthConfig } from './auth.config';
import { RedisRateLimitStorage } from './rate-limit.storage';

/** Where Better Auth's own endpoints live, under the versioned API prefix. */
export const AUTH_BASE_PATH = '/api/v1/auth';

/**
 * Failed attempts allowed per window before Better Auth starts rejecting.
 *
 * Supabase Auth was providing brute-force protection for free; leaving it
 * without replacing it would be the single biggest regression of this migration.
 * 20 requests per minute per identity is far above real human use and far below
 * anything useful for guessing a password.
 */
const RATE_LIMIT_MAX = 20;
/** Rate-limit window, in seconds. */
const RATE_LIMIT_WINDOW = 60;

const authRepo = new AuthRepository();

let instance: ReturnType<typeof buildAuth> | null = null;

/**
 * Constructs the Better Auth instance.
 *
 * Every mapping here exists so Better Auth adopts the schema we already have
 * instead of bringing its own:
 *
 * - `user` resolves to `prisma.user` — our `users` table — because the Prisma
 *   adapter addresses Prisma *models*, and `User` already `@@map`s there. So
 *   `users.id` stays the one identity every foreign key in the schema points at,
 *   with no second identity table and no indirection replacing
 *   `supabase_user_id`.
 * - `generateId: false` hands id generation back to Postgres
 *   (`gen_random_uuid()`), keeping the column uuid-typed.
 * - `name` lives in the pre-existing, nullable `display_name`.
 * - session/account/verification are renamed because a `Session` model already
 *   exists in this schema for tracing.
 */
function buildAuth() {
  const config = loadAuthConfig();

  return betterAuth({
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    secret: config.secret,
    baseURL: config.appUrl,
    basePath: AUTH_BASE_PATH,
    // Only our own origin may drive auth. Never `*` — cookies ride these requests.
    trustedOrigins: [config.appUrl],

    advanced: {
      database: { generateId: false },
      // Which header carries the client address, and which hops in it are ours.
      // Without this Better Auth reads a forwarded chain of more than one entry
      // as untrustworthy and rate-limits every caller in a single shared bucket
      // — see the constants behind these values for why that is severe.
      ipAddress: {
        ipAddressHeaders: config.ipAddressHeaders,
        trustedProxies: config.trustedProxies,
      },
    },

    user: {
      modelName: 'user',
      fields: { name: 'displayName' },
      additionalFields: {
        // Sent by the client at signup; optional, defaults to false so a
        // Google signup (which has no form step to ask) is opted out.
        marketingConsent: {
          type: 'boolean',
          required: false,
          input: true,
          defaultValue: false,
        },
        // Never sent by the client (`input: false`) — stamped unconditionally
        // by the `user.create.before` hook below, because both the signup
        // form and the Google button are disabled in the UI until the Terms
        // checkbox is checked. Nullable because existing accounts predate
        // this field and never saw the checkbox.
        termsAcceptedAt: {
          type: 'date',
          required: false,
          input: false,
        },
      },
    },
    session: {
      modelName: 'authSession',
      expiresIn: config.sessionTtlDays * 24 * 60 * 60,
    },
    account: {
      modelName: 'authAccount',
      accountLinking: {
        // Better Auth links a Google sign-in onto an existing email/password row
        // automatically, and the only thing stopping that from being a hijack is
        // `requireLocalEmailVerified` — the existing row must have proved it owns
        // the address. On a deployment with no mail transport the
        // `user.create.before` hook below marks every signup verified, which
        // would silence exactly that check: someone could register
        // victim@example.com with a password of their choosing, and the real
        // owner's first Google sign-in would be linked into the attacker's
        // account, leaving that password valid on it.
        //
        // So when nothing verified the address, no implicit link happens at all —
        // Google sign-in on a taken address fails with "account not linked"
        // instead. Where verification is real, the flag means a mailbox
        // round-trip actually happened and linking is safe to keep.
        disableImplicitLinking: !config.requireEmailVerification,
      },
    },
    verification: { modelName: 'authVerification' },

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: config.requireEmailVerification,
      // Signing a user in immediately is only safe when the address is not being
      // verified; otherwise the verification gate would be trivially skippable.
      autoSignIn: !config.requireEmailVerification,
      resetPasswordTokenExpiresIn: AUTH_LINK_TTL_SECONDS,
      // A reset must end every existing session, not just set a new password.
      // Someone resetting because their account was taken over would otherwise
      // leave the intruder signed in — and the confirmation email below would be
      // telling them about a lock they had not actually changed.
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user }) => {
        await sendPasswordChangedEmail({ userId: user.id, email: user.email });
      },
      sendResetPassword: async ({ user, url }) => {
        // An operator or admin may be waiting for this link instead of a
        // mailbox — the `EMAIL_TRANSPORT=none` escape hatch. Diverting here
        // rather than minting a parallel token keeps one implementation of the
        // reset flow, so an intercepted link expires and single-uses identically.
        if (deliverToCapture(user.email, url)) return;
        await sendPasswordResetEmail({ userId: user.id, email: user.email, url });
      },
    },

    emailVerification: {
      sendOnSignUp: config.requireEmailVerification,
      autoSignInAfterVerification: true,
      expiresIn: AUTH_LINK_TTL_SECONDS,
      sendVerificationEmail: async ({ user, url }) => {
        // The first-run claim creates an already-verified account (see the
        // `user.create.before` hook), so this message would ask the owner to
        // confirm something the server has already accepted. Checked first, and
        // synchronously, because Better Auth may invoke this callback without
        // awaiting it.
        if (isFirstRunClaim()) return;
        await sendVerifyEmail({ userId: user.id, email: user.email, url });
      },
      // Sent here rather than at signup: an unconfirmed address may belong to
      // someone who never asked to sign up, and welcoming them to a workspace
      // they did not create is the wrong first contact.
      afterEmailVerification: async (user) => {
        await sendWelcomeEmail({ userId: user.id, email: user.email });
      },
    },

    socialProviders: isGoogleEnabled()
      ? {
          google: {
            clientId: config.googleClientId!,
            clientSecret: config.googleClientSecret!,
          },
        }
      : {},

    rateLimit: {
      enabled: config.rateLimitEnabled,
      window: RATE_LIMIT_WINDOW,
      max: RATE_LIMIT_MAX,
      customStorage: new RedisRateLimitStorage(),
    },

    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            // Every sign-in records its device, and alerts the user only when the
            // device is new to the account. `auth_sessions` alone cannot answer
            // "new?" — sign-out deletes the row — hence `known_devices`.
            const user = await authRepo.findEmailById(session.userId);
            if (!user) return;
            await recordSignInDevice({
              userId: session.userId,
              email: user.email,
              ipAddress: session.ipAddress ?? null,
              userAgent: session.userAgent ?? null,
            });
          },
        },
      },
      user: {
        create: {
          before: async (user) => {
            // Stamped unconditionally: the signup UI disables every path that
            // creates an account (the email/password submit button and the
            // "Sign up with Google" button) until the Terms checkbox is
            // checked, so reaching this hook at all already implies
            // agreement. See the design doc for the accepted limitation that
            // this is a client-side gate, not a server-enforced one.
            const withTerms = { ...user, termsAcceptedAt: new Date() };

            // When verification is not required, record the address as verified
            // rather than leaving a row that says `false` forever.
            //
            // This is not cosmetic. Nobody will ever confirm these addresses —
            // on `EMAIL_TRANSPORT=none` no mail can be sent at all — so an
            // operator who later configures SMTP and turns verification on would
            // otherwise lock every existing account out of an instance they had
            // been using for months.
            //
            // A first-run claim is verified for a different reason: the claimer
            // proved access to the server's own log, which is a stronger signal
            // than a mailbox round-trip. Marking it here rather than with an
            // UPDATE after sign-up also keeps the claim off Better Auth's email
            // normalisation — a lookup by the raw address would miss the row it
            // just lowercased.
            if (!config.requireEmailVerification || isFirstRunClaim()) {
              return { data: { ...withTerms, emailVerified: true } };
            }
            return { data: withTerms };
          },
          after: async (user) => {
            // Every account owns a team from the moment it exists, so no
            // authenticated route has to cope with a teamless user. Idempotent,
            // and `requireAuth` calls it again as a safety net — see
            // `ensurePersonalTeam`.
            await authRepo.ensurePersonalTeam(user.id, user.email);
          },
        },
      },
    },
  });
}

/**
 * The process-wide Better Auth instance.
 *
 * Built lazily rather than at import time: constructing it reads the validated
 * config, and a module-level build would make merely importing this file throw
 * on a misconfigured environment — including inside tests that set their env in
 * `beforeAll`.
 *
 * @returns The memoized instance.
 * @throws {Error} If the auth configuration is invalid.
 */
export function getAuth(): ReturnType<typeof buildAuth> {
  if (!instance) instance = buildAuth();
  return instance;
}

/**
 * Drops the memoized instance so a test can change `process.env` and rebuild.
 * Never called by production code.
 */
export function resetAuth(): void {
  instance = null;
}

/**
 * Resolves the signed-in user from a request's cookies.
 *
 * @param headers - The incoming request headers, as a Fetch `Headers`.
 * @returns The session and user, or null when no valid session cookie is present.
 */
export async function getSessionFromHeaders(
  headers: Headers,
): Promise<SessionIdentity | null> {
  const result = await getAuth().api.getSession({ headers });
  if (!result?.user) return null;
  return {
    userId: result.user.id,
    email: result.user.email,
    // Better Auth's `name` is our `display_name`, which is nullable.
    displayName: result.user.name ?? null,
    emailVerified: !!result.user.emailVerified,
  };
}

/** The authenticated identity behind a session cookie. */
export interface SessionIdentity {
  /** `users.id` — the same id every foreign key in the schema uses. */
  userId: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
}
