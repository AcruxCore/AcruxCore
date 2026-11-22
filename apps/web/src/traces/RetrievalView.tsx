import { useState } from 'react';
import type { RetrievalView as RetrievalViewData, RetrievedDocument } from '@/api/types';

/** Documents shown before "Show all": enough to read the top hits without scrolling. */
const FIRST_SHOWN = 5;

/** Props of {@link RetrievalView}. */
export interface RetrievalViewProps {
  /** The span's `retrieval` field from the API. */
  view: RetrievalViewData;
  /** The step number of a span in this trace, to name the step a repeat came from. */
  stepOf: (spanId: string) => number | undefined;
  /** True when the span errored: with no output stored, the search failed rather than went uncaptured. */
  failed?: boolean;
}

/** The first non-empty line of a passage, for the one-line row. */
function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

/**
 * One returned document as a single row: rank, id or source, marks, score and the first
 * line of text. Clicking the row opens the full passage with its line breaks kept.
 */
function DocumentRow({
  doc,
  rank,
  stepOf,
}: {
  doc: RetrievedDocument;
  rank: number;
  stepOf: RetrievalViewProps['stepOf'];
}) {
  const [open, setOpen] = useState(false);
  const repeatStep = doc.repeatedFromSpanId ? stepOf(doc.repeatedFromSpanId) : undefined;
  return (
    <li
      className="rounded-lg border border-line-soft bg-surface"
      data-testid="retrieval-doc"
      data-doc-rank={rank}
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-elevated"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="w-6 shrink-0 font-mono text-[11px] text-faint" title="Position in the retriever's results">
          #{rank}
        </span>
        {doc.id && <span className="shrink-0 font-mono text-ink">{doc.id}</span>}
        {doc.source && doc.source !== doc.id && <span className="max-w-[30%] shrink-0 truncate text-muted">{doc.source}</span>}
        {!open && (
          <span className="min-w-0 flex-1 truncate text-ink" data-testid="retrieval-doc-preview">
            {firstLine(doc.text)}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {doc.repeatedFromSpanId && (
            <span className="rounded bg-warn/15 px-1.5 py-0.5 font-mono text-[10.5px] text-warn" title="An earlier search already returned this document">
              {repeatStep ? `repeated from step ${repeatStep}` : 'repeated'}
            </span>
          )}
          {doc.score !== null && <span className="font-mono text-muted" title="Score as the retriever reported it">{doc.score.toFixed(2)}</span>}
          <span className="text-faint" aria-hidden>{open ? '▾' : '▸'}</span>
        </span>
      </button>
      {open && (
        <p className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-line-soft px-3 py-2 text-[13px] leading-snug text-ink" data-testid="retrieval-doc-text">
          {doc.text}
          {doc.truncated && <span className="text-faint"> … (cut at 2,000 characters)</span>}
        </p>
      )}
    </li>
  );
}

/**
 * A search step drawn as what it searched for and what came back (issue #870): the
 * query, the counts, then one row per document. The first {@link FIRST_SHOWN} rows show,
 * then "Show all". Rows keep the retriever's order and show their rank.
 *
 * @param props - See {@link RetrievalViewProps}.
 * @returns The search section of a step's panel.
 */
export function RetrievalView({ view, stepOf, failed = false }: RetrievalViewProps) {
  const [showAll, setShowAll] = useState(false);
  const repeated = view.documents.filter((d) => d.repeatedFromSpanId).length;
  const ranked = view.documents.map((doc, i) => ({ doc, rank: i + 1 }));
  const shown = showAll ? ranked : ranked.filter(({ rank }) => rank <= FIRST_SHOWN);
  const hidden = ranked.length - shown.length;

  return (
    <section className="flex flex-col gap-2" data-testid="retrieval-view">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[11px] uppercase tracking-[0.06em] text-faint">Search</span>
        <span className="text-[13px] text-ink" data-testid="retrieval-query">
          {view.query !== null ? <>“{view.query}”</> : <span className="text-faint">No query found in the input</span>}
        </span>
        {view.outputCaptured && (
          <span className="font-mono text-[12px] text-muted" data-testid="retrieval-counts">
            {view.documentCount} {view.documentCount === 1 ? 'document' : 'documents'}
            {repeated > 0 && ` · ${repeated} repeated`}
          </span>
        )}
      </div>
      {!view.outputCaptured ? (
        <p className="text-[13px] text-muted" data-testid="retrieval-no-output">
          {failed ? 'The search failed before returning documents.' : 'No output was stored for this search.'}
        </p>
      ) : view.documents.length === 0 ? (
        <p className="text-[13px] text-muted">Searched, nothing came back.</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {shown.map(({ doc, rank }) => (
            <DocumentRow key={`${doc.id ?? 'doc'}-${rank}`} doc={doc} rank={rank} stepOf={stepOf} />
          ))}
        </ol>
      )}
      {hidden > 0 && (
        <button type="button" className="self-start text-[12px] text-accent hover:underline" onClick={() => setShowAll(true)}>
          Show {hidden} more
        </button>
      )}
      {showAll && ranked.length > FIRST_SHOWN && (
        <button type="button" className="self-start text-[12px] text-accent hover:underline" onClick={() => setShowAll(false)}>
          Show fewer
        </button>
      )}
      {view.documentCount > view.documents.length && (
        <p className="text-[12px] text-faint">
          Showing {view.documents.length} of {view.documentCount} documents.
        </p>
      )}
    </section>
  );
}
