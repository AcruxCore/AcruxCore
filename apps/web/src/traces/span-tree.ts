import type { Span } from '@/api/types';

/** One flattened row: a span paired with its depth in the (already-nested) tree. */
export interface SpanRow {
  span: Span;
  depth: number;
}

/**
 * Flattens the already-nested span tree the API returns into pre-order rows carrying
 * their depth, for indented rendering. This does not rebuild a tree from a flat list —
 * `GET /traces/:id` nests spans server-side (roots have `parentSpanId === null`) — it
 * only linearizes that nesting depth-first, preserving sibling order.
 *
 * @param spans - Root spans (or, recursively, a span's `children`).
 * @param depth - Starting depth; callers omit this (defaults to 0 for roots).
 * @returns Rows in pre-order (parent immediately followed by its descendants).
 */
export function flattenSpanTree(spans: Span[], depth = 0): SpanRow[] {
  const rows: SpanRow[] = [];
  for (const span of spans) {
    rows.push({ span, depth });
    if (span.children?.length) rows.push(...flattenSpanTree(span.children, depth + 1));
  }
  return rows;
}

/**
 * Computes the trace's time window from its spans: the earliest `startedAt` and the
 * total span in ms (latest `endedAt`, or `startedAt` when a span has not ended, minus
 * the earliest start). Walks the full nested tree, not just the roots, since a child
 * may start before or end after its parent's reported window in edge cases.
 *
 * @param spans - The trace's root spans (nested).
 * @returns `{ startMs, totalMs }`; falls back to `{ startMs: 0, totalMs: 1 }` when no
 *   span has a parseable `startedAt`, so downstream percentage math never divides by zero.
 */
export function traceWindow(spans: Span[]): { startMs: number; totalMs: number } {
  let min = Infinity;
  let max = -Infinity;
  const walk = (list: Span[]) => {
    for (const s of list) {
      if (s.startedAt) {
        const start = Date.parse(s.startedAt);
        if (!Number.isNaN(start)) {
          min = Math.min(min, start);
          max = Math.max(max, start);
        }
      }
      if (s.endedAt) {
        const end = Date.parse(s.endedAt);
        if (!Number.isNaN(end)) max = Math.max(max, end);
      }
      if (s.children?.length) walk(s.children);
    }
  };
  walk(spans);
  if (!Number.isFinite(min)) return { startMs: 0, totalMs: 1 };
  return { startMs: min, totalMs: Math.max(1, max - min) };
}

/**
 * Positions a span's latency bar within the trace window as percentages (0–100): a
 * left offset (time since the window start) and a width (the span's duration), both
 * clamped so the bar never overflows its track even if a span's reported timestamps
 * fall outside the window it is being drawn against.
 *
 * @param span - The span to position. Falls back to `startMs`/a zero duration when
 *   `startedAt`/`endedAt`/`latencyMs` are missing.
 * @param startMs - The trace window's start (`traceWindow(...).startMs`).
 * @param totalMs - The trace window's total duration (`traceWindow(...).totalMs`).
 * @returns `{ offsetPct, widthPct }`, each in `[0, 100]` with `offsetPct + widthPct <= 100`.
 */
export function spanBarGeometry(
  span: Span,
  startMs: number,
  totalMs: number,
): { offsetPct: number; widthPct: number } {
  const parsedStart = span.startedAt ? Date.parse(span.startedAt) : NaN;
  const start = Number.isNaN(parsedStart) ? startMs : parsedStart;
  const parsedEnd = span.endedAt ? Date.parse(span.endedAt) : NaN;
  const dur = span.latencyMs ?? (Number.isNaN(parsedEnd) ? 0 : parsedEnd - start);

  const offsetPct = Math.min(100, Math.max(0, ((start - startMs) / totalMs) * 100));
  const widthPct = Math.min(100 - offsetPct, Math.max(0.5, (dur / totalMs) * 100));
  return { offsetPct, widthPct };
}
