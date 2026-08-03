import type { BudgetAlertEmailProps, RenderedEmail } from '../email.types';
import {
  escapeHtml,
  formatUsd,
  htmlLayout,
  htmlStatTable,
  oneLine,
  textLayout,
} from './layout';

/** Fraction of the cap that triggers this warning. Fixed, per spec B §4. */
export const BUDGET_WARNING_THRESHOLD = 0.8;

/**
 * Renders the 80%-of-budget warning.
 *
 * Deliberately states the remaining headroom in dollars rather than only the
 * percentage: "$40.00 left" is what tells an owner whether to act today, and
 * "80% used" of an unknown cap tells them nothing.
 *
 * @param props - Team, budget scope, period, cap, current spend, links.
 * @returns Subject plus both HTML and text bodies.
 */
export function budgetThresholdEmail(props: BudgetAlertEmailProps): RenderedEmail {
  const percent = Math.round(BUDGET_WARNING_THRESHOLD * 100);
  const remaining = Math.max(0, props.limitUsd - props.spendUsd);
  const rows = [
    { label: 'Spent', value: formatUsd(props.spendUsd) },
    { label: 'Limit', value: formatUsd(props.limitUsd) },
    { label: 'Remaining', value: formatUsd(remaining) },
    { label: 'Scope', value: props.scopeLabel },
    { label: 'Resets', value: props.period === 'total' ? 'never' : `every ${props.period}` },
  ];

  const subject = oneLine(
    `${props.teamName}: ${percent}% of the ${props.period} budget used`,
  );

  const html = htmlLayout({
    heading: `${percent}% of your budget is used`,
    bodyHtml: [
      `<p style="margin:0 0 12px;"><strong>${escapeHtml(props.teamName)}</strong> has used ${escapeHtml(formatUsd(props.spendUsd))} of its ${escapeHtml(formatUsd(props.limitUsd))} ${escapeHtml(props.period)} budget.</p>`,
      htmlStatTable(rows),
      `<p style="margin:0 0 12px;">Gateway requests keep working until the limit is reached. At the limit they fail with <code>402 BUDGET_EXCEEDED</code>.</p>`,
    ].join(''),
    ctaLabel: 'Review budgets',
    ctaUrl: props.budgetsUrl,
    footerHtml: `You receive budget alerts because you are an owner or admin of this team. <a href="${escapeHtml(props.unsubscribeUrl)}" style="color:#6b7280;">Turn budget alerts off</a>.`,
  });

  const text = textLayout({
    heading: `${percent}% of your budget is used`,
    bodyLines: [
      `${props.teamName} has used ${formatUsd(props.spendUsd)} of its ${formatUsd(props.limitUsd)} ${props.period} budget.`,
      ...rows.map((r) => `${r.label}: ${r.value}`),
      'Gateway requests keep working until the limit is reached. At the limit they fail with 402 BUDGET_EXCEEDED.',
      'Review budgets:',
    ],
    ctaUrl: props.budgetsUrl,
    footerLines: [
      'You receive budget alerts because you are an owner or admin of this team.',
      `Turn budget alerts off: ${props.unsubscribeUrl}`,
    ],
  });

  return { subject, html, text };
}
