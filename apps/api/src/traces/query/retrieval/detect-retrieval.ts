import { extractDocuments, extractLooseDocuments, textDocument } from './extract-documents';
import { extractQuery } from './extract-query';
import { parseJsonString } from './parse-json-string';
import { splitFormattedText } from './split-formatted-text';
import { MAX_DOCUMENTS, type ExtractedDocument, type RetrievalView } from './retrieval.types';

/** The span fields detection reads. */
export interface DetectableSpan {
  kind: string;
  /** Only `toolKind` is read: the marker the SDK `tool` decorator writes. */
  attributes?: Record<string, unknown> | null;
  payload?: { input: unknown; output: unknown };
}

/**
 * Reads the developer's marker from a `tool` span. The SDKs write `toolKind` when a tool
 * is declared with `kind="retrieval"` or `kind="tool"`; any other value is ignored, so a
 * typo falls back to the shape check rather than hiding a search.
 */
function markerOf(span: DetectableSpan): 'retrieval' | 'tool' | null {
  const value = span.attributes?.toolKind;
  return value === 'retrieval' || value === 'tool' ? value : null;
}

/**
 * Documents of a step known to be a search: a `retrieval` span or a tool marked
 * `kind="retrieval"`. A list of documents reads as usual, and an empty list (bare or
 * under a field such as `matches`) is "nothing came back". A list of strings or of
 * id-only items gives one document each. A formatted string with numbered labels
 * (`"Doc 1: … Doc 2: …"`) becomes one document per label; any other non-empty output
 * becomes a single block, because the step is a search and the text is what a reader
 * needs.
 */
function declaredSearchDocuments(output: unknown): { documents: ExtractedDocument[]; count: number } {
  const found = extractDocuments(output) ?? extractLooseDocuments(output);
  if (found) return found;
  const decoded = parseJsonString(output);
  const text = typeof decoded === 'string' ? decoded : decoded == null ? '' : JSON.stringify(decoded);
  if (text.trim() === '' || text === '[]' || text === '{}') return { documents: [], count: 0 };
  const passages = splitFormattedText(text) ?? [text];
  return { documents: passages.slice(0, MAX_DOCUMENTS).map(textDocument), count: passages.length };
}

/** True when the span has a stored output to read documents from. */
function hasOutput(span: DetectableSpan): boolean {
  return span.payload !== undefined && span.payload.output !== null && span.payload.output !== undefined;
}

/** The view of a step known to be a search, from whatever it stored. */
function declaredSearch(span: DetectableSpan, detectedBy: 'kind' | 'marker'): RetrievalView {
  const captured = hasOutput(span);
  const found = captured ? declaredSearchDocuments(span.payload!.output) : { documents: [], count: 0 };
  return {
    detectedBy,
    query: span.payload ? extractQuery(span.payload.input) : null,
    documents: found.documents.map((d) => ({ ...d, repeatedFromSpanId: null })),
    documentCount: found.count,
    outputCaptured: captured,
  };
}

/**
 * Decides whether a span is a search step and, if so, reads its query and documents.
 *
 * A `retrieval` span is always a search, even with no payload or no documents —
 * "searched and found nothing" is the thing a reader needs to see, and `outputCaptured`
 * tells it apart from "the output was never stored". A `tool` span is a
 * search when the developer marked it `kind="retrieval"` in the SDK decorator, or, with
 * no marker, when its output is a list of documents (see `extractDocuments`); a tool that
 * returns a price or a list of rooms is not, and `kind="tool"` turns detection off. Every
 * other span kind is left alone.
 *
 * @param span - The span's kind and captured payload, if any.
 * @returns The search view, or null when the span is not a search.
 */
export function detectRetrieval(span: DetectableSpan): RetrievalView | null {
  if (span.kind === 'retrieval') return declaredSearch(span, 'kind');
  if (span.kind !== 'tool') return null;
  const marker = markerOf(span);
  if (marker === 'tool') return null;
  if (marker === 'retrieval') return declaredSearch(span, 'marker');

  if (!span.payload) return null;
  const found = extractDocuments(span.payload.output);
  if (!found || found.count === 0) return null;
  return {
    detectedBy: 'shape',
    query: extractQuery(span.payload.input),
    documents: found.documents.map((d) => ({ ...d, repeatedFromSpanId: null })),
    documentCount: found.count,
    outputCaptured: true,
  };
}
