import type { EvalRuleAlertEmailProps, RenderedEmail } from '../email.types';
import { escapeHtml, htmlLayout, oneLine, textLayout } from './layout';

/**
 * Renders the online-eval-rule alert. Two events share this template — a low score
 * (`props.score` set) and an automatic disable after a judge-call budget rejection
 * (`props.score: null`) — distinguished by whether `score` is null.
 *
 * @param props - Team, rule, verdict (or disable reason), links.
 * @returns Subject plus both HTML and text bodies.
 */
export function evalRuleAlertEmail(props: EvalRuleAlertEmailProps): RenderedEmail {
  const disabled = props.score === null;
  const heading = disabled
    ? 'An online evaluation rule was disabled'
    : 'An online evaluation rule flagged a low score';

  const subject = oneLine(
    disabled
      ? `${props.teamName}: online eval rule "${props.ruleName}" was disabled`
      : `${props.teamName}: online eval rule "${props.ruleName}" flagged a low score`,
  );

  const html = htmlLayout({
    heading,
    bodyHtml: disabled
      ? `<p style="margin:0 0 12px;"><strong>${escapeHtml(props.ruleName)}</strong> was disabled: ${escapeHtml(props.reason)}</p>`
      : `<p style="margin:0 0 12px;"><strong>${escapeHtml(props.ruleName)}</strong> scored a live trace at <strong>${props.score}/100</strong>. ${escapeHtml(props.reason)}</p>`,
    ctaLabel: 'View rules',
    ctaUrl: props.rulesUrl,
    footerHtml: `You receive online-eval alerts because you are an owner or admin of this team. <a href="${escapeHtml(props.unsubscribeUrl)}" style="color:#6b7280;">Turn these alerts off</a>.`,
  });

  const text = textLayout({
    heading,
    bodyLines: [
      disabled
        ? `${props.ruleName} was disabled: ${props.reason}`
        : `${props.ruleName} scored a live trace at ${props.score}/100. ${props.reason}`,
      'View rules:',
    ],
    ctaUrl: props.rulesUrl,
    footerLines: [
      'You receive online-eval alerts because you are an owner or admin of this team.',
      `Turn these alerts off: ${props.unsubscribeUrl}`,
    ],
  });

  return { subject, html, text };
}
