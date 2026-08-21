import type { BudgetAlertEmailProps, RenderedEmail } from '../email.types';
import {
  escapeHtml,
  formatUsd,
  htmlLayout,
  htmlStatTable,
  oneLine,
  textLayout,
} from './layout';

/**
 * Renders the budget-exhausted notice.
 *
 * Unlike the 80% warning, this one describes an outage: gateway calls are
 * already failing with `402 BUDGET_EXCEEDED`, so the body leads with the
 * consequence and states both ways out (raise the limit, or wait for the reset).
 *
 * @param props - Team, budget scope, period, cap, current spend, links.
 * @returns Subject plus both HTML and text bodies.
 */
export function budgetExhaustedEmail(props: BudgetAlertEmailProps): RenderedEmail {
  const resets =
    props.period === 'total'
      ? 'This budget never resets — raise the limit to resume.'
      : `This budget resets every ${props.period}. Requests resume automatically at the next reset, or as soon as you raise the limit.`;

  const rows = [
    { label: 'Spent', value: formatUsd(props.spendUsd) },
    { label: 'Limit', value: formatUsd(props.limitUsd) },
    { label: 'Scope', value: props.scopeLabel },
    { label: 'Resets', value: props.period === 'total' ? 'never' : `every ${props.period}` },
    ...(props.contributingSource ? [{ label: 'Contributed by', value: props.contributingSource }] : []),
  ];

  const subject = oneLine(`${props.teamName}: ${props.period} budget exhausted`);

  const html = htmlLayout({
    heading: 'Your budget is exhausted',
    bodyHtml: [
      `<p style="margin:0 0 12px;"><strong>${escapeHtml(props.teamName)}</strong> has reached its ${escapeHtml(formatUsd(props.limitUsd))} ${escapeHtml(props.period)} budget. Gateway requests on this scope are now failing with <code>402 BUDGET_EXCEEDED</code>.</p>`,
      htmlStatTable(rows),
      `<p style="margin:0 0 12px;">${escapeHtml(resets)}</p>`,
    ].join(''),
    ctaLabel: 'Raise the limit',
    ctaUrl: props.budgetsUrl,
    footerHtml: `You receive budget alerts because you are an owner or admin of this team. <a href="${escapeHtml(props.unsubscribeUrl)}" style="color:#6b7280;">Turn budget alerts off</a>.`,
  });

  const text = textLayout({
    heading: 'Your budget is exhausted',
    bodyLines: [
      `${props.teamName} has reached its ${formatUsd(props.limitUsd)} ${props.period} budget. Gateway requests on this scope are now failing with 402 BUDGET_EXCEEDED.`,
      ...rows.map((r) => `${r.label}: ${r.value}`),
      resets,
      'Raise the limit:',
    ],
    ctaUrl: props.budgetsUrl,
    footerLines: [
      'You receive budget alerts because you are an owner or admin of this team.',
      `Turn budget alerts off: ${props.unsubscribeUrl}`,
    ],
  });

  return { subject, html, text };
}
