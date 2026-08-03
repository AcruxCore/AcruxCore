import type { EvalRunFinishedEmailProps, RenderedEmail } from '../email.types';
import {
  escapeHtml,
  formatCount,
  htmlLayout,
  htmlStatTable,
  oneLine,
  textLayout,
} from './layout';

/**
 * Renders a duration for display.
 *
 * Minutes-and-seconds past a minute, because "4m 12s" reads faster than
 * "252s" for the multi-minute runs this email exists for.
 */
function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'unknown';
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/**
 * Renders the eval-run-finished email.
 *
 * Carries counts and a deep link, never the run's outputs: an eval report is a
 * table that belongs in the app, and cell outputs may contain the customer
 * prompt data that `email_log` deliberately refuses to store.
 *
 * @param props - Team, experiment, outcome, cell counts, duration, links.
 * @returns Subject plus both HTML and text bodies.
 */
export function evalRunFinishedEmail(props: EvalRunFinishedEmailProps): RenderedEmail {
  const failed = props.outcome === 'failed';
  const rows = [
    { label: 'Outcome', value: failed ? 'Failed' : 'Succeeded' },
    { label: 'Cells succeeded', value: formatCount(props.succeededCells) },
    { label: 'Cells errored', value: formatCount(props.erroredCells) },
    { label: 'Duration', value: formatDuration(props.durationSeconds) },
  ];

  const subject = oneLine(
    `${props.experimentName}: run ${failed ? 'failed' : 'finished'}`,
  );

  const html = htmlLayout({
    heading: `Run ${failed ? 'failed' : 'finished'}: ${escapeHtml(props.experimentName)}`,
    bodyHtml: [
      `<p style="margin:0 0 12px;">Your experiment run in <strong>${escapeHtml(props.teamName)}</strong> has ${failed ? 'failed' : 'finished'}.</p>`,
      htmlStatTable(rows),
      `<p style="margin:0 0 12px;">Scores and per-cell outputs are in the app — they are deliberately not included here.</p>`,
    ].join(''),
    ctaLabel: 'Open the run',
    ctaUrl: props.runUrl,
    footerHtml: `You receive run results because you started this run, or you are an owner of this team. <a href="${escapeHtml(props.unsubscribeUrl)}" style="color:#6b7280;">Turn run notifications off</a>.`,
  });

  const text = textLayout({
    heading: `Run ${failed ? 'failed' : 'finished'}: ${props.experimentName}`,
    bodyLines: [
      `Your experiment run in ${props.teamName} has ${failed ? 'failed' : 'finished'}.`,
      ...rows.map((r) => `${r.label}: ${r.value}`),
      'Scores and per-cell outputs are in the app — they are deliberately not included here.',
      'Open the run:',
    ],
    ctaUrl: props.runUrl,
    footerLines: [
      'You receive run results because you started this run, or you are an owner of this team.',
      `Turn run notifications off: ${props.unsubscribeUrl}`,
    ],
  });

  return { subject, html, text };
}
