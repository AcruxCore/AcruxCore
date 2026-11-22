import type { SpanNode } from '../query.types';
import { detectRetrieval } from './detect-retrieval';
import type { RetrievedDocument } from './retrieval.types';

/** Characters of normalised text that identify a document with no id. */
const TEXT_KEY_CHARS = 200;

/** Lowercase words with punctuation stripped. */
function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

/**
 * What makes two returned documents "the same": the start of the text, plus the id when
 * there is one. The id alone is not enough, because positional ids (`1, 2, 3`) and two
 * retrievers that share an id space would mark unrelated passages as repeats. An id-only
 * document (no text) matches by id alone.
 */
function documentKey(doc: RetrievedDocument): string {
  const text = words(doc.text).join(' ').slice(0, TEXT_KEY_CHARS);
  return doc.id !== null ? `id:${doc.id}|${text}` : `text:${text}`;
}

/** Every node of the tree, sorted by start time (ties keep tree order). */
function byStart(roots: SpanNode[]): SpanNode[] {
  const all: SpanNode[] = [];
  const walk = (nodes: SpanNode[]) => {
    for (const n of nodes) {
      all.push(n);
      walk(n.children);
    }
  };
  walk(roots);
  return all
    .map((node, i) => ({ node, i }))
    .sort((a, b) => a.node.startedAt.localeCompare(b.node.startedAt) || a.i - b.i)
    .map(({ node }) => node);
}

/**
 * Adds a `retrieval` view to every search step of a trace, in place (issue #870).
 *
 * Steps are visited in start order. A document a later step returns again gets
 * `repeatedFromSpanId` pointing at the first step that returned it.
 *
 * @param roots - The trace's span tree from `buildSpanTree`.
 */
export function annotateRetrieval(roots: SpanNode[]): void {
  const ordered = byStart(roots);
  const firstSeen = new Map<string, string>();

  for (const node of ordered) {
    const view = detectRetrieval(node);
    if (!view) continue;
    for (const doc of view.documents) {
      const key = documentKey(doc);
      const earlier = firstSeen.get(key);
      if (earlier !== undefined && earlier !== node.spanId) doc.repeatedFromSpanId = earlier;
      else if (earlier === undefined) firstSeen.set(key, node.spanId);
    }
    node.retrieval = view;
  }
}
