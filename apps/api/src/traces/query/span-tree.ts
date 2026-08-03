import type { SpanRow, SpanPayloadRow } from '../../shared/db/schema';
import type { SpanNode } from './query.types';

/**
 * Maps a stored span row to a detail-tree node. `payload` is attached only when a
 * captured `span_payloads` row was supplied for this span (looked up by internal id).
 *
 * @param s - The stored span row.
 * @param payload - The span's captured payload row, if any.
 * @returns A SpanNode with an empty `children` array, ready for linking.
 */
function toNode(s: SpanRow, payload?: SpanPayloadRow): SpanNode {
  const node: SpanNode = {
    spanId: s.spanRef,
    parentSpanId: s.parentSpanRef,
    kind: s.kind,
    name: s.name,
    status: s.status,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt ? s.endedAt.toISOString() : null,
    latencyMs: s.latencyMs,
    model: s.model,
    provider: s.provider,
    promptTokens: s.promptTokens,
    completionTokens: s.completionTokens,
    totalTokens: s.totalTokens,
    costUsd: s.costUsd === null ? null : Number(s.costUsd),
    promptVersionId: s.promptVersionId,
    gatewayRequestId: s.gatewayRequestId,
    errorMessage: s.errorMessage,
    attributes: (s.attributes ?? {}) as Record<string, unknown>,
    tags: s.tags ?? [],
    metadata: (s.metadata ?? {}) as Record<string, unknown>,
    children: [],
  };
  if (payload) node.payload = { input: payload.input, output: payload.output, variables: payload.variables };
  return node;
}

/**
 * Assembles a flat span list into a parent/child tree by `span_ref`/`parent_span_ref`.
 * A span is a **root** when its parent is null, references a span not in this list
 * (dangling), is itself (self-cycle), or is a member of a longer cycle (A→B→…→A).
 * Nodes that merely *lead into* a cycle (but aren't themselves part of it) keep
 * their real parent, which may now be a root because the cycle was broken there.
 *
 * Since each span has exactly one raw parent, the parent links form a "functional
 * graph": every connected component is either a tree hanging off a root, or a tree
 * hanging off exactly one cycle. Resolution walks each span's ancestor chain once,
 * marking nodes `visiting` as they're pushed onto the current walk's path; landing
 * on a `visiting` node means the tail of the path (from that node onward) is a
 * cycle, so every span in that tail is rooted. Each span is walked at most once
 * across all calls to `resolve` (subsequent visits short-circuit on `resolved`),
 * so the whole pass is O(n) and always terminates — no infinite loop is possible.
 *
 * @param spans - All spans of one trace, in the desired child ordering (e.g. by start).
 * @param payloads - Optional map of internal span id → captured payload row.
 * @returns The root SpanNodes; each node's `children` are ordered as the input was.
 */
export function buildSpanTree(
  spans: SpanRow[],
  payloads?: Record<string, SpanPayloadRow>,
): SpanNode[] {
  const nodeMap = new Map<string, SpanNode>();
  for (const s of spans) nodeMap.set(s.spanRef, toNode(s, payloads?.[s.id]));

  // Raw effective parent ref per span: null if missing, dangling, or self-referential.
  const rawParentOf = new Map<string, string | null>();
  for (const s of spans) {
    const ref = s.parentSpanRef;
    rawParentOf.set(s.spanRef, ref && nodeMap.has(ref) && ref !== s.spanRef ? ref : null);
  }

  // Final resolved parent ref per span (null = root), filled in by resolve().
  const parentOf = new Map<string, string | null>();
  const state = new Map<string, 'unvisited' | 'visiting' | 'resolved'>();
  for (const s of spans) state.set(s.spanRef, 'unvisited');

  /**
   * Resolves the final parent of `startRef` and every unresolved ancestor walked
   * to get there, rooting every member of any cycle discovered along the way.
   *
   * @param startRef - The span_ref to begin walking from.
   */
  function resolve(startRef: string): void {
    const path: string[] = [];
    let cur: string | null = startRef;
    while (cur !== null && state.get(cur) === 'unvisited') {
      state.set(cur, 'visiting');
      path.push(cur);
      cur = rawParentOf.get(cur) ?? null;
    }

    if (cur !== null && state.get(cur) === 'visiting') {
      // `cur` is on our current path: path[cycleStart..] forms a cycle — root them.
      const cycleStart = path.indexOf(cur);
      for (let i = cycleStart; i < path.length; i++) {
        parentOf.set(path[i], null);
        state.set(path[i], 'resolved');
      }
      // Nodes before the cycle keep their real parent (now possibly a rooted cycle member).
      for (let i = 0; i < cycleStart; i++) {
        parentOf.set(path[i], rawParentOf.get(path[i]) ?? null);
        state.set(path[i], 'resolved');
      }
    } else {
      // Ran off the end (null) or joined an already-resolved chain — no cycle here.
      for (const ref of path) {
        parentOf.set(ref, rawParentOf.get(ref) ?? null);
        state.set(ref, 'resolved');
      }
    }
  }

  for (const s of spans) resolve(s.spanRef);

  const roots: SpanNode[] = [];
  for (const s of spans) {
    const node = nodeMap.get(s.spanRef)!;
    const parentRef = parentOf.get(s.spanRef) ?? null;
    if (parentRef === null) roots.push(node);
    else nodeMap.get(parentRef)!.children.push(node);
  }
  return roots;
}
