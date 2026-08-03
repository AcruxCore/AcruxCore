import type { RenderedEmail, TeamInviteEmailProps } from '../email.types';
import { escapeHtml, formatExpiry, htmlLayout, oneLine, textLayout } from './layout';

/**
 * Renders the team invite email.
 *
 * `teamName` and `inviterName` are user-supplied and escaped for the HTML part;
 * the subject is collapsed to one line so neither can inject a header break.
 *
 * @param props - Team, inviter, granted role, absolute accept URL, ISO expiry.
 * @returns Subject plus both HTML and text bodies.
 * @throws {RangeError} When `props.expiresAt` is not a parseable date.
 */
export function teamInviteEmail(props: TeamInviteEmailProps): RenderedEmail {
  const expires = formatExpiry(props.expiresAt);

  const subject = oneLine(`${props.inviterName} invited you to ${props.teamName} on acruxcore`);

  const html = htmlLayout({
    heading: `You've been invited to ${escapeHtml(props.teamName)}`,
    bodyHtml: [
      `<p style="margin:0 0 12px;">${escapeHtml(props.inviterName)} invited you to join <strong>${escapeHtml(props.teamName)}</strong> on acruxcore.</p>`,
      `<p style="margin:0 0 12px;">You'll join with the <strong>${escapeHtml(props.role)}</strong> role.</p>`,
    ].join(''),
    ctaLabel: 'Accept invite',
    ctaUrl: props.inviteUrl,
    footerHtml: `This invite is single-use and expires on ${escapeHtml(expires)}. If the button doesn't work, paste this link into your browser:<br />${escapeHtml(props.inviteUrl)}`,
  });

  const text = textLayout({
    heading: `You've been invited to ${props.teamName}`,
    bodyLines: [
      `${props.inviterName} invited you to join ${props.teamName} on acruxcore.`,
      `You'll join with the ${props.role} role.`,
      'Accept the invite:',
    ],
    ctaUrl: props.inviteUrl,
    footerLines: [`This invite is single-use and expires on ${expires}.`],
  });

  return { subject, html, text };
}
