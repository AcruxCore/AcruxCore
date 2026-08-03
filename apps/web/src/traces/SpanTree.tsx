import { Fragment, useEffect, useRef, useState } from 'react';
import { StatusDot } from '@/ui';
import { KIND_META, formatLatency } from './format';
import { flattenSpanTree, spanBarGeometry, traceWindow } from './span-tree';
import { SpanPanel } from './SpanPanel';
import type { Feedback, Span } from '@/api/types';

export interface SpanTreeProps {
  spans: Span[];
  traceId: string;
  /** The trace's full feedback list; filtered per-span for the expanded panel. */
  feedback: Feedback[];
  /**
   * A span reference (`Span.spanId`) to expand and scroll into view on mount — set
   * from a feedback row's `#span-<ref>` deep link (F4). `null`/unset expands nothing,
   * and a ref that matches no row is a no-op (e.g. a deleted span).
   */
  initialExpandedSpanId?: string | null;
}

/**
 * The span tree: indented rows scaled to the trace's duration. Each row shows a kind
 * chip, the span name, a status dot (paired with text), and a latency bar positioned by
 * the span's start offset within the trace window. Clicking a row expands its detail
 * panel in place directly below it (Q17) — the panel is a sibling of the row, not a
 * child, since it contains its own interactive controls (feedback buttons) that
 * cannot nest inside the row's `<button>`.
 *
 * @param spans - The trace's root spans, already nested (`children` per span).
 * @param traceId - The trace these spans belong to (threaded into the panel for feedback posting).
 * @param feedback - The trace's full feedback list, filtered per span inside the panel.
 * @param initialExpandedSpanId - Span reference to expand and scroll to on mount (F4 deep link); `null`/unset expands nothing, an unmatched ref is a no-op.
 */
export function SpanTree({ spans, traceId, feedback, initialExpandedSpanId }: SpanTreeProps) {
  const [expandedId, setExpandedId] = useState<string | null>(initialExpandedSpanId ?? null);
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const win = traceWindow(spans);
  const rows = flattenSpanTree(spans);

  // Scroll a deep-linked span into view once, on mount. Runs only when this trace
  // actually has a matching row — a stale/deleted span ref (or a span not present in
  // this render) simply leaves the tree unscrolled, per the "do nothing gracefully"
  // requirement (F4).
  useEffect(() => {
    if (!initialExpandedSpanId) return;
    const row = rowRefs.current[initialExpandedSpanId];
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Intentionally mount-only: this is a one-time deep-link scroll, not a
    // continuous sync with `initialExpandedSpanId`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center text-[13px] text-muted">
        No spans recorded for this trace.
      </div>
    );
  }

  return (
    <div className="flex flex-col rounded-xl border border-line" data-testid="span-tree">
      {rows.map(({ span, depth }) => {
        const g = spanBarGeometry(span, win.startMs, win.totalMs);
        const kind = KIND_META[span.kind];
        const expanded = span.spanId === expandedId;
        return (
          <Fragment key={span.spanId}>
            <button
              type="button"
              ref={(el) => {
                rowRefs.current[span.spanId] = el;
              }}
              onClick={() => setExpandedId(expanded ? null : span.spanId)}
              data-testid="span-row"
              aria-expanded={expanded}
              className={`flex items-center gap-3 border-b border-line-soft px-3 py-2 text-left last:border-b-0 hover:bg-elevated ${
                expanded ? 'bg-elevated' : 'bg-surface'
              }`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2" style={{ paddingLeft: `${depth * 16}px` }}>
                <span
                  className="shrink-0 rounded border border-line-soft px-1.5 py-0.5 font-mono text-[10.5px] text-muted"
                  title={kind.label}
                >
                  {kind.glyph} {kind.label}
                </span>
                <span className="truncate text-[13px] text-ink">{span.name}</span>
                {/* An unnamed gateway span is labelled with its start timestamp (phase-3 FAQ
                    Q15), which says nothing about the call — so surface the model here, where
                    a reader scanning the waterfall needs it. */}
                {span.model && (
                  <span
                    className="hidden shrink-0 rounded bg-bg px-1.5 py-0.5 font-mono text-[10.5px] text-muted sm:inline"
                    title={`Model: ${span.model}`}
                  >
                    {span.model}
                  </span>
                )}
                <StatusDot status={span.status} dotOnly />
              </div>
              <div className="relative hidden h-2.5 w-40 shrink-0 rounded bg-bg sm:block" aria-hidden>
                <div
                  className={`absolute top-0 h-full rounded ${span.status === 'error' ? 'bg-danger' : 'bg-accent'}`}
                  style={{ left: `${g.offsetPct}%`, width: `${g.widthPct}%` }}
                />
              </div>
              <span className="w-16 shrink-0 text-right font-mono text-[12px] text-muted">
                {formatLatency(span.latencyMs)}
              </span>
            </button>
            {expanded && (
              <SpanPanel
                span={span}
                traceId={traceId}
                feedback={feedback.filter((f) => f.spanId === span.spanId)}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
