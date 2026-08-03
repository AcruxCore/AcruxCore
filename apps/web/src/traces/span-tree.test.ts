import { describe, expect, it } from 'vitest';
import { flattenSpanTree, spanBarGeometry, traceWindow } from './span-tree';
import type { Span } from '@/api/types';

const tree: Span[] = [
  {
    spanId: 's1',
    parentSpanId: null,
    kind: 'llm',
    name: 'root',
    status: 'ok',
    startedAt: '2026-07-04T10:00:00.000Z',
    endedAt: '2026-07-04T10:00:01.000Z',
    latencyMs: 1000,
    model: null,
    provider: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    costUsd: null,
    promptVersionId: null,
    gatewayRequestId: null,
    errorMessage: null,
    attributes: {},
    tags: [],
    metadata: {},
    children: [
      {
        spanId: 's2',
        parentSpanId: 's1',
        kind: 'tool',
        name: 'child',
        status: 'ok',
        startedAt: '2026-07-04T10:00:00.500Z',
        endedAt: '2026-07-04T10:00:00.800Z',
        latencyMs: 300,
        model: null,
        provider: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        costUsd: null,
        promptVersionId: null,
        gatewayRequestId: null,
        errorMessage: null,
        attributes: {},
        tags: [],
        metadata: {},
        children: [],
      },
    ],
  },
];

describe('span-tree', () => {
  it('flattenSpanTree yields pre-order rows with correct depth', () => {
    const rows = flattenSpanTree(tree);
    expect(rows.map((r) => [r.span.spanId, r.depth])).toEqual([
      ['s1', 0],
      ['s2', 1],
    ]);
  });

  it('traceWindow spans the earliest start to the latest end', () => {
    const w = traceWindow(tree);
    expect(w.startMs).toBe(Date.parse('2026-07-04T10:00:00.000Z'));
    expect(w.totalMs).toBe(1000);
  });

  it('spanBarGeometry scales offset + width against the trace window', () => {
    const w = traceWindow(tree);
    const g = spanBarGeometry(tree[0].children[0], w.startMs, w.totalMs); // child s2
    expect(g.offsetPct).toBeCloseTo(50, 5); // starts 500ms into a 1000ms window
    expect(g.widthPct).toBeCloseTo(30, 5); // 300ms of 1000ms
  });

  it('traceWindow falls back to a 1ms window when spans have no timestamps', () => {
    const w = traceWindow([]);
    expect(w).toEqual({ startMs: 0, totalMs: 1 });
  });

  it('spanBarGeometry clamps width so a bar never overflows its track', () => {
    // A span reported with a duration exceeding the trace window (e.g. a later end
    // than any sibling) must not push offsetPct + widthPct past 100.
    const overrun: Span = {
      ...tree[0].children[0],
      spanId: 's3',
      startedAt: '2026-07-04T10:00:00.900Z',
      endedAt: '2026-07-04T10:00:02.000Z',
      latencyMs: 1100,
    };
    const g = spanBarGeometry(overrun, Date.parse('2026-07-04T10:00:00.000Z'), 1000);
    expect(g.offsetPct + g.widthPct).toBeLessThanOrEqual(100);
  });
});
