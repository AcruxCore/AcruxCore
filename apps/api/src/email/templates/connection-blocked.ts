import type { ConnectionBlockedEmailProps, RenderedEmail } from '../email.types';
import { escapeHtml, htmlLayout, htmlStatTable, oneLine, textLayout } from './layout';

/**
 * Renders the notice that the gateway refused to call a provider connection
 * because its base URL resolves to an address it will not reach — a private,
 * loopback or cloud-metadata address.
 *
 * The lead sentence changes with `servedByFallback`, because the two cases
 * need different things from the reader. When a fallback answered, the call
 * returned a normal 200 and nothing is visibly wrong: the message has to say
 * that plainly, or a reader who checks the dashboard, sees green, and deletes
 * the mail has been actively misled. When nothing answered, they already have
 * a failing request in front of them and what they need is the cause.
 *
 * @param props - Team, connection, provider, the guard's own reason, links.
 * @returns Subject plus both HTML and text bodies.
 */
export function connectionBlockedEmail(props: ConnectionBlockedEmailProps): RenderedEmail {
  const rows = [
    { label: 'Connection', value: props.connectionName },
    { label: 'Provider', value: props.provider },
    { label: 'Refused because', value: props.reason },
  ];

  const heading = 'A provider connection cannot be reached';
  const subject = oneLine(
    `${props.teamName}: the "${props.connectionName}" connection cannot be called`,
  );

  const lead = props.servedByFallback
    ? `AcruxCore could not call <strong>${escapeHtml(props.connectionName)}</strong>, so a fallback model answered instead. The requests succeeded, which is why nothing looks wrong — but every call is going to the fallback, at the fallback's prices, until this is fixed.`
    : `AcruxCore could not call <strong>${escapeHtml(props.connectionName)}</strong>, and no fallback model was able to answer, so the requests failed.`;

  const leadText = props.servedByFallback
    ? `AcruxCore could not call "${props.connectionName}", so a fallback model answered instead. The requests succeeded, which is why nothing looks wrong — but every call is going to the fallback, at the fallback's prices, until this is fixed.`
    : `AcruxCore could not call "${props.connectionName}", and no fallback model was able to answer, so the requests failed.`;

  const remedy =
    'The gateway only calls public addresses. Open the connection and set its base URL to one, or remove the base URL to use the provider default.';

  const html = htmlLayout({
    heading,
    bodyHtml: [
      `<p style="margin:0 0 12px;">${lead}</p>`,
      htmlStatTable(rows),
      `<p style="margin:0 0 12px;">${escapeHtml(remedy)}</p>`,
    ].join(''),
    ctaLabel: 'Open connections',
    ctaUrl: props.connectionsUrl,
    footerHtml: `You receive connection health alerts because you are an owner or admin of this team. <a href="${escapeHtml(props.unsubscribeUrl)}" style="color:#6b7280;">Turn connection health alerts off</a>.`,
  });

  const text = textLayout({
    heading,
    bodyLines: [leadText, ...rows.map((r) => `${r.label}: ${r.value}`), remedy, 'Open connections:'],
    ctaUrl: props.connectionsUrl,
    footerLines: [
      'You receive connection health alerts because you are an owner or admin of this team.',
      `Turn connection health alerts off: ${props.unsubscribeUrl}`,
    ],
  });

  return { subject, html, text };
}
