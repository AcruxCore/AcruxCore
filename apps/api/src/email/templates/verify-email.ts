import type { AuthLinkEmailProps, RenderedEmail } from '../email.types';
import { escapeHtml, htmlLayout, textLayout } from './layout';

/**
 * Renders the "confirm your email address" email sent at signup.
 *
 * Contains no user-supplied text at all — only our own copy and a URL we
 * generated — which is why nothing here needs collapsing to one line the way the
 * invite subject does.
 *
 * @param props - The absolute verification URL and its lifetime in minutes.
 * @returns Subject plus both HTML and text bodies.
 */
export function verifyEmailEmail(props: AuthLinkEmailProps): RenderedEmail {
  const subject = 'Confirm your acruxcore email address';

  const html = htmlLayout({
    heading: 'Confirm your email address',
    bodyHtml: [
      `<p style="margin:0 0 12px;">Thanks for signing up for acruxcore. Confirm this address to finish setting up your account.</p>`,
      `<p style="margin:0 0 12px;">The link works once and expires in ${props.expiresInMinutes} minutes.</p>`,
    ].join(''),
    ctaLabel: 'Confirm email address',
    ctaUrl: props.url,
    footerHtml: `If you didn't create an acruxcore account, you can ignore this email — nothing was activated.<br />If the button doesn't work, paste this link into your browser:<br />${escapeHtml(props.url)}`,
  });

  const text = textLayout({
    heading: 'Confirm your email address',
    bodyLines: [
      'Thanks for signing up for acruxcore. Confirm this address to finish setting up your account.',
      `The link works once and expires in ${props.expiresInMinutes} minutes.`,
      'Confirm your email address:',
    ],
    ctaUrl: props.url,
    footerLines: [
      "If you didn't create an acruxcore account, you can ignore this email — nothing was activated.",
    ],
  });

  return { subject, html, text };
}
