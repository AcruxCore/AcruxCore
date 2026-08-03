import type { RenderedEmail, WeeklyDigestEmailProps } from '../email.types';
import { escapeHtml, htmlLayout, htmlStatTable, oneLine, textLayout } from './layout';

/**
 * Renders the weekly usage digest.
 *
 * Every number arrives pre-formatted (see `digest.format.ts`) so this function
 * stays a pure layout concern and the arithmetic edge cases — a percentage
 * change from a zero baseline, a zero delta — are unit-tested without a
 * database.
 *
 * Counts and money only. No prompt text, trace input/output, or eval result ever
 * reaches this template: payload capture defaults to on, so quoting content
 * would route customer data into mailboxes, and `email_log` stores no bodies, so
 * it would also be untraceable afterwards.
 *
 * @param props - Team, window, pre-formatted stats/models/budgets, links.
 * @returns Subject plus both HTML and text bodies.
 */
export function weeklyDigestEmail(props: WeeklyDigestEmailProps): RenderedEmail {
  const window = `${props.fromDate} → ${props.toDate}`;

  const modelRows = props.topModels.map((m) => ({ label: m.model, value: m.value }));
  const budgetRows = props.budgets.map((b) => ({ label: b.scope, value: b.value }));

  const subject = oneLine(`${props.teamName}: your week on acruxcore (${window})`);

  const section = (title: string, rows: { label: string; value: string }[]): string =>
    rows.length === 0
      ? ''
      : `<h2 style="margin:22px 0 6px;font-size:14px;color:#111827;">${escapeHtml(title)}</h2>${htmlStatTable(rows)}`;

  const html = htmlLayout({
    heading: `Your week in ${escapeHtml(props.teamName)}`,
    bodyHtml: [
      `<p style="margin:0 0 14px;color:#6b7280;">${escapeHtml(window)}</p>`,
      htmlStatTable(
        props.stats.map((s) => ({ label: s.label, value: s.value, note: s.delta })),
      ),
      section('Top models by spend', modelRows),
      section('Budgets', budgetRows),
    ].join(''),
    ctaLabel: 'Open usage',
    ctaUrl: props.usageUrl,
    footerHtml: `You receive this weekly summary because you are an owner or admin of this team. <a href="${escapeHtml(props.unsubscribeUrl)}" style="color:#6b7280;">Unsubscribe</a>.`,
  });

  const textSection = (title: string, rows: { label: string; value: string }[]): string[] =>
    rows.length === 0 ? [] : [`${title}:`, ...rows.map((r) => `  ${r.label}: ${r.value}`)];

  const text = textLayout({
    heading: `Your week in ${props.teamName}`,
    bodyLines: [
      window,
      ...props.stats.map((s) => `${s.label}: ${s.value}${s.delta ? ` (${s.delta})` : ''}`),
      ...textSection('Top models by spend', modelRows),
      ...textSection('Budgets', budgetRows),
      'Open usage:',
    ],
    ctaUrl: props.usageUrl,
    footerLines: [
      'You receive this weekly summary because you are an owner or admin of this team.',
      `Unsubscribe: ${props.unsubscribeUrl}`,
    ],
  });

  return {
    subject,
    html,
    text,
    // RFC 8058 one-click unsubscribe. Gmail and Yahoo require these of bulk
    // senders, and the digest is the platform's only non-transactional email —
    // a visible footer link alone does not satisfy them, which is why the header
    // pair exists in addition to the link above. `List-Unsubscribe-Post` is what
    // tells the client it may POST without opening a browser.
    headers: {
      'List-Unsubscribe': `<${props.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
