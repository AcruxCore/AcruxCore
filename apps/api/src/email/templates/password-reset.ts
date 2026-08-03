import type { AuthLinkEmailProps, RenderedEmail } from '../email.types';
import { escapeHtml, htmlLayout, textLayout } from './layout';

/**
 * Renders the password-reset email.
 *
 * The "you can ignore this" line is not filler: because the request endpoint
 * answers identically whether or not an address has an account, this email is
 * the first thing a person learns from — and someone whose address was typed in
 * by mistake needs to be told that nothing happened.
 *
 * @param props - The absolute reset URL and its lifetime in minutes.
 * @returns Subject plus both HTML and text bodies.
 */
export function passwordResetEmail(props: AuthLinkEmailProps): RenderedEmail {
  const subject = 'Reset your acruxcore password';

  const html = htmlLayout({
    heading: 'Reset your password',
    bodyHtml: [
      `<p style="margin:0 0 12px;">Someone asked to reset the password for this acruxcore account. Choose a new one with the button below.</p>`,
      `<p style="margin:0 0 12px;">The link works once and expires in ${props.expiresInMinutes} minutes.</p>`,
    ].join(''),
    ctaLabel: 'Choose a new password',
    ctaUrl: props.url,
    footerHtml: `If this wasn't you, you can ignore this email — your password has not changed and no one can use this link without opening it.<br />If the button doesn't work, paste this link into your browser:<br />${escapeHtml(props.url)}`,
  });

  const text = textLayout({
    heading: 'Reset your password',
    bodyLines: [
      'Someone asked to reset the password for this acruxcore account. Choose a new one with the link below.',
      `The link works once and expires in ${props.expiresInMinutes} minutes.`,
      'Choose a new password:',
    ],
    ctaUrl: props.url,
    footerLines: [
      "If this wasn't you, you can ignore this email — your password has not changed.",
    ],
  });

  return { subject, html, text };
}
