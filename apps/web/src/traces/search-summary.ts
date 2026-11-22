import type { RetrievalView, SpanStatus } from '@/api/types';

/**
 * The one-line summary of a search step on its span-tree row: what it searched for and
 * what came back, such as `“refunds” → 3 docs · 1 repeated`.
 *
 * When the step stored no output, the row says `failed` (the step errored) or `output
 * not stored`, never `0 docs`, which would read as "searched and found nothing".
 *
 * @param view - The span's `retrieval` field.
 * @param status - The span's status, to tell a failed search from an uncaptured one.
 * @returns The summary text.
 */
export function searchSummary(view: RetrievalView, status: SpanStatus): string {
  const query = view.query !== null ? `“${view.query}” → ` : '';
  if (!view.outputCaptured) return `${query}${status === 'error' ? 'failed' : 'output not stored'}`;
  const repeated = view.documents.filter((d) => d.repeatedFromSpanId).length;
  const docs = `${view.documentCount} ${view.documentCount === 1 ? 'doc' : 'docs'}`;
  return `${query}${docs}${repeated > 0 ? ` · ${repeated} repeated` : ''}`;
}
