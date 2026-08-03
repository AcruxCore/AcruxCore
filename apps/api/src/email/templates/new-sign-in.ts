import type { NewSignInEmailProps, RenderedEmail } from '../email.types';
import { formatExpiry, htmlLayout, htmlStatTable, textLayout } from './layout';

/** Shown when the proxy supplied no IP or the client sent no user-agent. */
const UNKNOWN = 'Not reported';

/**
 * Renders the new-device sign-in alert.
 *
 * Fires on a device this account has not signed in from before, never on every
 * login — see the `known_devices` table for why. An alert that arrived on each
 * ordinary sign-in would be trained away within a week, and would then fail to
 * be noticed on the one occasion it mattered.
 *
 * The user-agent is escaped and shown verbatim rather than parsed into
 * "Chrome on macOS": it is attacker-controlled input, and a wrong-but-friendly
 * summary would be worse for the one person trying to work out whether the
 * sign-in was theirs.
 *
 * @param props - When, from where, and where to reset if it was not them.
 * @returns Subject plus both HTML and text bodies.
 */
export function newSignInEmail(props: NewSignInEmailProps): RenderedEmail {
  const when = formatExpiry(props.signedInAt);
  const ip = props.ipAddress || UNKNOWN;
  const agent = props.userAgent || UNKNOWN;
  const subject = 'New sign-in to your acruxcore account';

  const html = htmlLayout({
    heading: 'New sign-in to your account',
    bodyHtml: [
      `<p style="margin:0 0 12px;">Someone signed in to this acruxcore account from a device we haven't seen before.</p>`,
      htmlStatTable([
        { label: 'When', value: when },
        { label: 'IP address', value: ip },
        { label: 'Device', value: agent },
      ]),
      `<p style="margin:12px 0;">If that was you, nothing to do — we won't email you again for this device.</p>`,
      `<p style="margin:0 0 12px;"><strong>If it wasn't</strong>, reset your password now. That signs out every session, including theirs.</p>`,
    ].join(''),
    ctaLabel: 'Reset your password',
    ctaUrl: props.resetUrl,
    footerHtml: `You're receiving this because it is a change to your account's security. It cannot be turned off.`,
  });

  const text = textLayout({
    heading: 'New sign-in to your account',
    bodyLines: [
      "Someone signed in to this acruxcore account from a device we haven't seen before.",
      `When: ${when}`,
      `IP address: ${ip}`,
      `Device: ${agent}`,
      "If that was you, nothing to do — we won't email you again for this device.",
      "If it wasn't, reset your password now. That signs out every session, including theirs:",
    ],
    ctaUrl: props.resetUrl,
    footerLines: [
      "You're receiving this because it is a change to your account's security. It cannot be turned off.",
    ],
  });

  return { subject, html, text };
}
