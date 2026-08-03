import type { MembershipEmailProps, RenderedEmail } from '../email.types';
import { escapeHtml, htmlLayout, oneLine, textLayout } from './layout';

/**
 * Renders the role-changed email.
 *
 * @param props - Team, the affected member, who changed it, the new role, links.
 * @returns Subject plus both HTML and text bodies.
 */
export function memberRolesChangedEmail(props: MembershipEmailProps): RenderedEmail {
  const role = props.role ?? 'none';

  const subject = oneLine(`Your role in ${props.teamName} changed`);

  const html = htmlLayout({
    heading: `Role updated in ${escapeHtml(props.teamName)}`,
    bodyHtml: [
      `<p style="margin:0 0 12px;">${escapeHtml(props.actorName)} updated ${escapeHtml(props.memberName)}'s role in <strong>${escapeHtml(props.teamName)}</strong>.</p>`,
      `<p style="margin:0 0 12px;">The role now held: <strong>${escapeHtml(role)}</strong>.</p>`,
    ].join(''),
    ctaLabel: 'Open the team',
    ctaUrl: props.teamUrl,
    footerHtml: `You receive membership notifications because this change affects you, or you are an owner or admin of this team. <a href="${escapeHtml(props.unsubscribeUrl)}" style="color:#6b7280;">Turn them off</a>.`,
  });

  const text = textLayout({
    heading: `Role updated in ${props.teamName}`,
    bodyLines: [
      `${props.actorName} updated ${props.memberName}'s role in ${props.teamName}.`,
      `The role now held: ${role}.`,
      'Open the team:',
    ],
    ctaUrl: props.teamUrl,
    footerLines: [
      'You receive membership notifications because this change affects you, or you are an owner or admin of this team.',
      `Turn them off: ${props.unsubscribeUrl}`,
    ],
  });

  return { subject, html, text };
}
