import type { MembershipEmailProps, RenderedEmail } from '../email.types';
import { escapeHtml, htmlLayout, oneLine, textLayout } from './layout';

/**
 * Renders the member-joined email — the counterpart to the invite email, so the
 * inviting admin learns the invite was actually accepted rather than having to
 * poll the members list.
 *
 * @param props - Team, the member who joined, their role, links.
 *   `actorName` is the joiner themselves here; there is no third party.
 *   `role` is always set for this event (a member cannot join without one), so
 *   the role sentence is dropped rather than filled with a placeholder if it
 *   somehow arrives null — a wrong sentence is worse than a missing one.
 * @returns Subject plus both HTML and text bodies.
 */
export function memberJoinedEmail(props: MembershipEmailProps): RenderedEmail {
  const subject = oneLine(`${props.memberName} joined ${props.teamName}`);

  const html = htmlLayout({
    heading: `${escapeHtml(props.memberName)} joined ${escapeHtml(props.teamName)}`,
    bodyHtml: [
      `<p style="margin:0 0 12px;"><strong>${escapeHtml(props.memberName)}</strong> accepted their invite and is now a member of <strong>${escapeHtml(props.teamName)}</strong>.</p>`,
      props.role
        ? `<p style="margin:0 0 12px;">They joined with the <strong>${escapeHtml(props.role)}</strong> role.</p>`
        : '',
    ].join(''),
    ctaLabel: 'View team members',
    ctaUrl: props.teamUrl,
    footerHtml: `You receive membership notifications because you are an owner or admin of this team. <a href="${escapeHtml(props.unsubscribeUrl)}" style="color:#6b7280;">Turn them off</a>.`,
  });

  const text = textLayout({
    heading: `${props.memberName} joined ${props.teamName}`,
    bodyLines: [
      `${props.memberName} accepted their invite and is now a member of ${props.teamName}.`,
      ...(props.role ? [`They joined with the ${props.role} role.`] : []),
      'View team members:',
    ],
    ctaUrl: props.teamUrl,
    footerLines: [
      'You receive membership notifications because you are an owner or admin of this team.',
      `Turn them off: ${props.unsubscribeUrl}`,
    ],
  });

  return { subject, html, text };
}
