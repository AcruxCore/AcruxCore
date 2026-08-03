import type { MembershipEmailProps, RenderedEmail } from '../email.types';
import { escapeHtml, htmlLayout, oneLine, textLayout } from './layout';

/**
 * Renders the member-removed email.
 *
 * Sent to the removed person as well as the team's owners/admins, so it carries
 * no call-to-action link: the recipient may no longer have access to the team it
 * talks about, and a button leading to a 403 is worse than no button. The
 * unsubscribe link still appears — it points at the preferences of whichever
 * team the recipient is still in.
 *
 * @param props - Team, the removed member, who removed them, links. `role` is
 *   ignored (the member has none now) and expected to be null.
 * @returns Subject plus both HTML and text bodies.
 */
export function memberRemovedEmail(props: MembershipEmailProps): RenderedEmail {
  const selfRemoved = props.memberName === props.actorName;
  const sentence = selfRemoved
    ? `${props.memberName} left ${props.teamName}.`
    : `${props.actorName} removed ${props.memberName} from ${props.teamName}.`;

  const subject = oneLine(
    selfRemoved
      ? `${props.memberName} left ${props.teamName}`
      : `${props.memberName} was removed from ${props.teamName}`,
  );

  const html = htmlLayout({
    heading: selfRemoved
      ? `${escapeHtml(props.memberName)} left ${escapeHtml(props.teamName)}`
      : `Removed from ${escapeHtml(props.teamName)}`,
    bodyHtml: [
      `<p style="margin:0 0 12px;">${escapeHtml(sentence)}</p>`,
      `<p style="margin:0 0 12px;">Access to that team's prompts, keys, and traces has ended. Any personal API keys scoped to it no longer work.</p>`,
    ].join(''),
    footerHtml: `This notice is always sent, because losing access to a team is a security-relevant change. Other membership notifications can be <a href="${escapeHtml(props.unsubscribeUrl)}" style="color:#6b7280;">turned off</a>.`,
  });

  const text = textLayout({
    heading: selfRemoved
      ? `${props.memberName} left ${props.teamName}`
      : `Removed from ${props.teamName}`,
    bodyLines: [
      sentence,
      "Access to that team's prompts, keys, and traces has ended. Any personal API keys scoped to it no longer work.",
    ],
    footerLines: [
      'This notice is always sent, because losing access to a team is a security-relevant change.',
      `Other membership notifications can be turned off: ${props.unsubscribeUrl}`,
    ],
  });

  return { subject, html, text };
}
