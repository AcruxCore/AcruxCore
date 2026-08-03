import { z } from 'zod';

const Schema = z
  .object({
    transport: z.enum(['ses', 'smtp', 'memory', 'none']),
    sesRegion: z.string().min(1).optional(),
    sesAccessKeyId: z.string().min(1).optional(),
    sesSecretAccessKey: z.string().min(1).optional(),
    smtpHost: z.string().min(1).optional(),
    smtpPort: z.coerce.number().int().positive().max(65535).optional(),
    smtpUser: z.string().min(1).optional(),
    smtpPassword: z.string().min(1).optional(),
    /**
     * Implicit TLS (port 465). Absent or false means STARTTLS is negotiated,
     * which is what port 587 wants. Optional rather than defaulted so a caller
     * constructing an `EmailConfig` by hand (the SES tests do) need not mention
     * an SMTP-only field.
     */
    smtpSecure: z.boolean().optional(),
    from: z.string().min(3),
    replyTo: z.string().min(3).optional(),
    appUrl: z.string().url(),
  })
  .refine(
    (c) =>
      c.transport !== 'ses' ||
      (!!c.sesRegion && !!c.sesAccessKeyId && !!c.sesSecretAccessKey),
    {
      message:
        'EMAIL_TRANSPORT=ses requires SES_REGION, SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY',
    },
  )
  .refine((c) => c.transport !== 'smtp' || (!!c.smtpHost && !!c.smtpPort), {
    message: 'EMAIL_TRANSPORT=smtp requires SMTP_HOST and SMTP_PORT',
  })
  // Credentials are optional (a local MTA or an internal relay may need none),
  // but half a credential pair is always a misconfiguration, not a choice.
  .refine((c) => !c.smtpUser === !c.smtpPassword, {
    message: 'SMTP_USER and SMTP_PASSWORD must be set together, or neither',
  });

/** Validated email configuration for this process. */
export type EmailConfig = z.infer<typeof Schema>;

/** `From` used when `EMAIL_FROM` is unset. */
const DEFAULT_FROM = 'acruxcore <no-reply@acruxcore.com>';
/** `Reply-To` used when `EMAIL_REPLY_TO` is unset — the single support inbox. */
const DEFAULT_REPLY_TO = 'support@acruxcore.com';
/** Base URL for links in emails when `APP_URL` is unset outside production. */
const DEFAULT_DEV_APP_URL = 'http://localhost:5173';

let cached: EmailConfig | null = null;

/**
 * Reads and validates the email environment once per process.
 *
 * Defaults are chosen so a developer running `npm run dev` with no AWS
 * credentials still boots: the transport falls back to `memory` outside
 * production, which prints what would have been sent instead of spending money
 * or emailing a real person.
 *
 * @returns The memoized, validated config.
 * @throws {Error} When a value is missing or malformed — deliberately at boot
 *   (see {@link assertEmailConfig}) rather than as silent non-delivery hours
 *   later.
 */
export function loadEmailConfig(): EmailConfig {
  if (cached) return cached;

  const isProduction = process.env.NODE_ENV === 'production';
  const parsed = Schema.safeParse({
    transport: process.env.EMAIL_TRANSPORT ?? (isProduction ? 'ses' : 'memory'),
    sesRegion: process.env.SES_REGION || undefined,
    sesAccessKeyId: process.env.SES_ACCESS_KEY_ID || undefined,
    sesSecretAccessKey: process.env.SES_SECRET_ACCESS_KEY || undefined,
    smtpHost: process.env.SMTP_HOST || undefined,
    smtpPort: process.env.SMTP_PORT || undefined,
    smtpUser: process.env.SMTP_USER || undefined,
    smtpPassword: process.env.SMTP_PASSWORD || undefined,
    smtpSecure: process.env.SMTP_SECURE === 'true',
    from: process.env.EMAIL_FROM || DEFAULT_FROM,
    replyTo: process.env.EMAIL_REPLY_TO || DEFAULT_REPLY_TO,
    appUrl: process.env.APP_URL || (isProduction ? '' : DEFAULT_DEV_APP_URL),
  });

  if (!parsed.success) {
    throw new Error(`Invalid email configuration: ${parsed.error.issues[0].message}`);
  }

  cached = parsed.data;
  return cached;
}

/**
 * True when this deployment cannot send email at all.
 *
 * Never a default — an unset `EMAIL_TRANSPORT` resolves to `ses` in production
 * and `memory` elsewhere. A self-hoster with no mail server opts in explicitly.
 *
 * Callers use it to skip enqueueing rather than to swallow a failure later:
 * queueing a message no transport can deliver would fill `email_log` with
 * `failed` rows a self-hoster can do nothing about. `EMAIL_TRANSPORT=none` is
 * an explicit statement of intent, never inferred from absent SES variables —
 * inference is how someone ends up with unusable accounts and no idea why.
 *
 * @returns True when `EMAIL_TRANSPORT=none`.
 */
export function isEmailDisabled(): boolean {
  return loadEmailConfig().transport === 'none';
}

/**
 * Validates the email environment at startup so a misconfiguration crashes the
 * process immediately, the same contract `assertMasterKey()` already has.
 *
 * @throws {Error} When the configuration is invalid.
 */
export function assertEmailConfig(): void {
  loadEmailConfig();
}

/**
 * Drops the memoized config so a test can change `process.env` and reload.
 * Never called by production code.
 */
export function resetEmailConfig(): void {
  cached = null;
}
