import type { RenderedEmail, WelcomeEmailProps } from '../email.types';
import { escapeHtml, htmlLayout, oneLine, textLayout } from './layout';

/**
 * Renders the welcome email, sent once an address is confirmed.
 *
 * Deliberately sent *after* verification rather than at signup: an unconfirmed
 * address might belong to someone who never asked to sign up, and welcoming them
 * to a workspace they did not create is the wrong first impression.
 *
 * @param props - Where to land the new user, and their own team's name.
 * @returns Subject plus both HTML and text bodies.
 */
export function welcomeEmail(props: WelcomeEmailProps): RenderedEmail {
  // The team name is user-supplied (it derives from their address), so the
  // subject is collapsed to one line — a newline there would let it inject a
  // header break.
  const subject = oneLine('Welcome to acruxcore');

  const html = htmlLayout({
    heading: 'Your account is ready',
    bodyHtml: [
      `<p style="margin:0 0 12px;">Your email is confirmed and <strong>${escapeHtml(props.teamName)}</strong> is set up. You're the owner, so you can invite teammates whenever you like.</p>`,
      `<p style="margin:0 0 12px;">A good first step is to create a prompt and commit a version — everything else in acruxcore builds on that.</p>`,
    ].join(''),
    ctaLabel: 'Open acruxcore',
    ctaUrl: props.dashboardUrl,
    footerHtml: `Questions? Just reply to this email and a person will read it.`,
  });

  const text = textLayout({
    heading: 'Your account is ready',
    bodyLines: [
      `Your email is confirmed and ${props.teamName} is set up. You're the owner, so you can invite teammates whenever you like.`,
      'A good first step is to create a prompt and commit a version — everything else in acruxcore builds on that.',
      'Open acruxcore:',
    ],
    ctaUrl: props.dashboardUrl,
    footerLines: ['Questions? Just reply to this email and a person will read it.'],
  });

  return { subject, html, text };
}
