import { Link, useLocation, useParams } from 'react-router-dom';
import { Empty, PageSpinner, StatusDot, Badge } from '@/ui';
import { useTrace } from '@/api';
import { dateTime, timeAgo } from '@/lib/format';
import { SpanTree } from './SpanTree';
import { FeedbackPanel } from './FeedbackPanel';
import { ScoresPanel } from './ScoresPanel';
import { Collapsible } from './Collapsible';
import { formatCount, formatUsd } from './format';

/** Matches the `#span-<ref>` hash produced by feedback-row deep links (F4). */
const SPAN_HASH_RE = /^#span-(.+)$/;

/**
 * The `/traces/:id` detail view: a header (name, status, session link, rollup totals,
 * relative time) above a collapsible trace-metadata section, the span tree (each row
 * expands in place — Q17), the trace-level feedback panel, and the online-eval rule
 * scores panel below.
 */
export function TraceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const { data, isLoading, isError } = useTrace(id ?? null);

  // A feedback row can deep-link here as `/traces/:id#span-<ref>` (F4). `spanId` on
  // `Feedback` is the span reference (`SpanNode.spanId`), not an internal UUID, so this
  // is matched directly against `Span.spanId` — no lookup table needed. A hand-typed,
  // malformed hash (e.g. a stray `%`) falls back to `null` instead of throwing.
  const hashMatch = SPAN_HASH_RE.exec(location.hash);
  let deepLinkedSpanId: string | null = null;
  if (hashMatch) {
    try {
      deepLinkedSpanId = decodeURIComponent(hashMatch[1]);
    } catch {
      deepLinkedSpanId = null;
    }
  }

  if (isLoading) return <PageSpinner />;
  if (isError || !data) {
    return <Empty title="Trace not found" description="This trace does not exist or is not in your team." />;
  }

  const { trace, spans } = data;
  const feedback = data.feedback ?? [];
  const traceFeedback = feedback.filter((f) => f.spanId === null);

  return (
    <div className="flex flex-col gap-5">
      <Link to="/traces" className="text-[12px] text-muted hover:text-ink">
        ← Traces
      </Link>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[20px] font-semibold tracking-tight">
            {trace.name ?? <span className="font-mono text-faint">{trace.id.slice(0, 8)}</span>}
          </h1>
          <StatusDot status={trace.status} />
          {trace.sessionId && (
            <Link
              to={`/sessions/${encodeURIComponent(trace.sessionId)}`}
              className="font-mono text-[12px] text-varhi hover:underline"
            >
              session: {trace.sessionId}
            </Link>
          )}
          {trace.tags.map((tag) => (
            <Badge key={tag} className="px-2 py-0.5 text-[11px]">{tag}</Badge>
          ))}
        </div>
        <div className="flex flex-wrap gap-4 text-[13px] text-muted">
          <span>{trace.spanCount} spans</span>
          <span className="font-mono">{formatCount(trace.totalTokens)} tokens</span>
          <span className="font-mono">{formatUsd(trace.totalCostUsd)}</span>
          <span title={dateTime(trace.startedAt)}>{timeAgo(trace.startedAt)}</span>
        </div>
      </header>

      {Object.keys(trace.metadata).length > 0 && (
        <section className="rounded-lg border border-line-soft bg-surface px-3 py-2" data-testid="trace-metadata">
          <Collapsible label="Metadata" testId="trace-metadata-toggle">
            {Object.entries(trace.metadata).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between border-b border-line-soft py-1.5 text-[13px] last:border-0">
                <span className="text-muted">{k}</span>
                <span className="font-mono text-ink">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
              </div>
            ))}
          </Collapsible>
        </section>
      )}

      <SpanTree spans={spans} traceId={trace.id} feedback={feedback} initialExpandedSpanId={deepLinkedSpanId} />

      <FeedbackPanel traceId={trace.id} feedback={traceFeedback} />

      <ScoresPanel evalScores={data.evalScores ?? []} />
    </div>
  );
}
