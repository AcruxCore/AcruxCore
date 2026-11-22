import type { Span } from '@/api/types';

/** Span kinds that are an action the agent took, and so get a step number. */
const STEP_KINDS: ReadonlySet<Span['kind']> = new Set(['tool', 'retrieval']);

/**
 * Numbers the agent's actions (tool and retrieval spans) 1, 2, 3… in the order they
 * started, so "repeated from step 1" can point at a row a reader can find.
 *
 * Start time, not row order: the API marks repeats in start order, and the two differ
 * when branches run in parallel (two sub-agents searching at once). Ties keep row order,
 * as the API's do.
 *
 * @param rows - The span tree's flattened rows, in display order.
 * @returns spanId → 1-based step number; model calls and wrappers are absent.
 */
export function numberSteps(rows: ReadonlyArray<{ span: Pick<Span, 'spanId' | 'kind' | 'startedAt'> }>): Map<string, number> {
  const ordered = rows
    .map(({ span }, i) => ({ span, i }))
    .filter(({ span }) => STEP_KINDS.has(span.kind))
    .sort((a, b) => (a.span.startedAt ?? '').localeCompare(b.span.startedAt ?? '') || a.i - b.i);
  return new Map(ordered.map(({ span }, n) => [span.spanId, n + 1]));
}
