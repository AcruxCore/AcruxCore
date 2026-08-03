import { buildSpanTree } from './span-tree';
import type { SpanRow } from '../../shared/db/schema';

let seq = 0;

/** Builds a minimal SpanRow. `id` defaults unique; only linkage/display fields matter here. */
function mkSpan(partial: { spanRef: string; parentSpanRef?: string | null; name?: string }): SpanRow {
  return {
    id: `id-${partial.spanRef}-${++seq}`,
    teamId: 'team-1',
    traceId: 'trace-1',
    spanRef: partial.spanRef,
    parentSpanRef: partial.parentSpanRef ?? null,
    kind: 'other',
    name: partial.name ?? partial.spanRef,
    status: 'ok',
    startedAt: new Date('2026-07-04T10:00:00Z'),
    endedAt: null,
    latencyMs: null,
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
    createdAt: new Date('2026-07-04T10:00:00Z'),
  } as unknown as SpanRow;
}

describe('buildSpanTree', () => {
  it('nests children under parents by span_ref (roots = null parent)', () => {
    const tree = buildSpanTree([
      mkSpan({ spanRef: 's1' }),
      mkSpan({ spanRef: 's2', parentSpanRef: 's1' }),
      mkSpan({ spanRef: 's3', parentSpanRef: 's1' }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].spanId).toBe('s1');
    expect(tree[0].children.map((c) => c.spanId)).toEqual(['s2', 's3']);
  });

  it('supports multiple independent roots', () => {
    const tree = buildSpanTree([
      mkSpan({ spanRef: 'r1' }),
      mkSpan({ spanRef: 'r2' }),
      mkSpan({ spanRef: 'c1', parentSpanRef: 'r2' }),
    ]);
    const ids = tree.map((n) => n.spanId).sort();
    expect(ids).toEqual(['r1', 'r2']);
    const r2 = tree.find((n) => n.spanId === 'r2')!;
    expect(r2.children.map((c) => c.spanId)).toEqual(['c1']);
  });

  it('treats a dangling parent (ref not present) as a root', () => {
    const tree = buildSpanTree([mkSpan({ spanRef: 's2', parentSpanRef: 'ghost' })]);
    expect(tree).toHaveLength(1);
    expect(tree[0].spanId).toBe('s2');
    expect(tree[0].parentSpanId).toBe('ghost'); // raw ref preserved on the node
  });

  it('treats a self-referential parent as a root (no infinite loop)', () => {
    const tree = buildSpanTree([mkSpan({ spanRef: 's1', parentSpanRef: 's1' })]);
    expect(tree).toHaveLength(1);
    expect(tree[0].spanId).toBe('s1');
  });

  it('breaks a 2-node cycle by rooting both (terminates)', () => {
    const tree = buildSpanTree([
      mkSpan({ spanRef: 'a', parentSpanRef: 'b' }),
      mkSpan({ spanRef: 'b', parentSpanRef: 'a' }),
    ]);
    // No infinite loop; every node still surfaces exactly once (as a root here).
    const ids = tree.map((n) => n.spanId).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('breaks a 3-node cycle by rooting participants (terminates)', () => {
    const tree = buildSpanTree([
      mkSpan({ spanRef: 'a', parentSpanRef: 'c' }),
      mkSpan({ spanRef: 'b', parentSpanRef: 'a' }),
      mkSpan({ spanRef: 'c', parentSpanRef: 'b' }),
    ]);
    // Cycle a→c→b→a: all three get rooted rather than lost or looping.
    const ids = tree.map((n) => n.spanId).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('attaches a node leading into a cycle to the cycle member it points at, not lost or looped', () => {
    // a→b→c→a is a cycle (all three root); d→a leads into it and should hang off
    // the now-rooted 'a' rather than being rooted itself or dropped.
    const tree = buildSpanTree([
      mkSpan({ spanRef: 'd', parentSpanRef: 'a' }),
      mkSpan({ spanRef: 'a', parentSpanRef: 'b' }),
      mkSpan({ spanRef: 'b', parentSpanRef: 'c' }),
      mkSpan({ spanRef: 'c', parentSpanRef: 'a' }),
    ]);
    const rootIds = tree.map((n) => n.spanId).sort();
    expect(rootIds).toEqual(['a', 'b', 'c']);
    const a = tree.find((n) => n.spanId === 'a')!;
    expect(a.children.map((c) => c.spanId)).toEqual(['d']);
  });

  it('attaches payload by internal span id, not by span_ref', () => {
    const s1 = mkSpan({ spanRef: 's1' });
    const tree = buildSpanTree([s1], {
      [s1.id]: {
        spanId: s1.id,
        teamId: 'team-1',
        input: { prompt: 'hi' },
        output: { text: 'hello' },
        createdAt: new Date('2026-07-04T10:00:00Z'),
      } as unknown as import('../../shared/db/schema').SpanPayloadRow,
    });
    expect(tree[0].payload).toEqual({ input: { prompt: 'hi' }, output: { text: 'hello' } });
  });

  it('omits payload when no matching row is supplied', () => {
    const s1 = mkSpan({ spanRef: 's1' });
    const tree = buildSpanTree([s1], {});
    expect(tree[0].payload).toBeUndefined();
  });

  it('orders children as given in the input array', () => {
    const tree = buildSpanTree([
      mkSpan({ spanRef: 'root' }),
      mkSpan({ spanRef: 'third', parentSpanRef: 'root' }),
      mkSpan({ spanRef: 'first', parentSpanRef: 'root' }),
      mkSpan({ spanRef: 'second', parentSpanRef: 'root' }),
    ]);
    expect(tree[0].children.map((c) => c.spanId)).toEqual(['third', 'first', 'second']);
  });

  it('handles an empty span list', () => {
    expect(buildSpanTree([])).toEqual([]);
  });
});
