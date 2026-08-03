import '../src/shared/env/load-root-env';
import { SmtpTransport } from '../src/email/smtp.transport';

/**
 * Sends one throwaway message through the configured SMTP transport.
 *
 * Exists to tell "our transport is misconfigured" apart from "the provider
 * rejected this recipient" — a fresh SES account is in sandbox mode and accepts
 * only verified addresses, a failure that otherwise surfaces indirectly as a
 * `failed` row in `email_log` well after the fact.
 *
 * Usage: `npx tsx scripts/smtp-probe.ts <recipient@example.com>`
 */
const to = process.argv[2];
if (!to?.includes('@')) {
  console.error('Usage: npx tsx scripts/smtp-probe.ts <recipient@example.com>');
  process.exit(1);
}

const from = process.env.EMAIL_FROM || 'acruxcore <no-reply@acruxcore.com>';

const transport = new SmtpTransport({
  transport: 'smtp',
  smtpHost: process.env.SMTP_HOST!,
  smtpPort: Number(process.env.SMTP_PORT),
  smtpUser: process.env.SMTP_USER,
  smtpPassword: process.env.SMTP_PASSWORD,
  smtpSecure: process.env.SMTP_SECURE === 'true',
  from,
  appUrl: process.env.APP_URL || 'http://localhost:5173',
});

transport
  .send({
    to,
    from,
    subject: 'acruxcore SMTP probe',
    html: '<p>If you can read this, SMTP delivery works.</p>',
    text: 'If you can read this, SMTP delivery works.',
  })
  .then((r) => console.log('SENT ok, messageId =', r.providerMessageId))
  .catch((e: Error) => console.log('FAILED:', e.name, '|', e.message));
