import type { PasswordChangedEmailProps, RenderedEmail } from '../email.types';
import { escapeHtml, formatExpiry, htmlLayout, textLayout } from './layout';

/**
 * Renders the "your password was changed" confirmation.
 *
 * This is the email that lets someone find out their account was taken over, so
 * it is sent unconditionally — no preference turns it off, exactly like the
 * member-removed notice. It is also why every existing session is revoked at the
 * same time: telling a victim that their password changed while leaving the
 * attacker signed in would be worse than useless.
 *
 * @param props - When the change happened, and where to start another reset.
 * @returns Subject plus both HTML and text bodies.
 */
export function passwordChangedEmail(props: PasswordChangedEmailProps): RenderedEmail {
  const when = formatExpiry(props.changedAt);
  const subject = 'Your acruxcore password was changed';

  const html = htmlLayout({
    heading: 'Your password was changed',
    bodyHtml: [
      `<p style="margin:0 0 12px;">The password for this acruxcore account was changed on ${escapeHtml(when)}.</p>`,
      `<p style="margin:0 0 12px;">You were signed out everywhere, so you'll need to sign in again with the new password.</p>`,
      `<p style="margin:0 0 12px;"><strong>If this wasn't you</strong>, reset the password immediately — whoever changed it can sign in until you do.</p>`,
    ].join(''),
    ctaLabel: 'Reset the password',
    ctaUrl: props.resetUrl,
    footerHtml: `You're receiving this because it is a change to your account's security. It cannot be turned off.`,
  });

  const text = textLayout({
    heading: 'Your password was changed',
    bodyLines: [
      `The password for this acruxcore account was changed on ${when}.`,
      "You were signed out everywhere, so you'll need to sign in again with the new password.",
      "If this wasn't you, reset the password immediately — whoever changed it can sign in until you do:",
    ],
    ctaUrl: props.resetUrl,
    footerLines: [
      "You're receiving this because it is a change to your account's security. It cannot be turned off.",
    ],
  });

  return { subject, html, text };
}
