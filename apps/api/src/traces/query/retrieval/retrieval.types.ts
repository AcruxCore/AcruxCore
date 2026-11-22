/**
 * One document a search step returned, normalised from whatever shape the tool or
 * retriever produced (LangChain, LlamaIndex, Pinecone-style, OpenInference, plain).
 */
export interface RetrievedDocument {
  /** The document's own id (`id` / `doc_id`), or null when it has none. */
  id: string | null;
  /** The passage text, cut to {@link MAX_DOCUMENT_TEXT} characters. */
  text: string;
  /** `score`, `similarity` or `distance` as stored; null when absent. Never re-scaled. */
  score: number | null;
  /** A human label for where it came from: `source`, `url` or `title`. */
  source: string | null;
  /** The document's metadata object, with a JSON-string metadata parsed. */
  metadata: Record<string, unknown> | null;
  /** True when `text` was cut. */
  truncated: boolean;
  /** spanId of the earliest earlier search in the trace that returned the same document. */
  repeatedFromSpanId: string | null;
}

/**
 * The search view of one span, added to `GET /traces/:id` on read (issue #870).
 * `detectedBy: 'kind'` means the span was reported as `retrieval`; `'marker'` means a
 * `tool` span the developer declared with `kind="retrieval"`; `'shape'` means a `tool`
 * span whose output looked like a list of documents.
 */
export interface RetrievalView {
  detectedBy: 'kind' | 'marker' | 'shape';
  /** What the step searched for, or null when the input names no query. */
  query: string | null;
  /** At most {@link MAX_DOCUMENTS} documents, in the order the step returned them. */
  documents: RetrievedDocument[];
  /** How many documents the step returned, before the cap. */
  documentCount: number;
  /**
   * False when the step stored no output: capture was off, retention deleted it, or the
   * tool threw. `documentCount` is then 0 but means "unknown", not "found nothing".
   */
  outputCaptured: boolean;
}

/** A document as read from one span, before the trace-wide marks are filled in. */
export type ExtractedDocument = Omit<RetrievedDocument, 'repeatedFromSpanId'>;

/** Most documents returned per span, so one huge result cannot balloon the response. */
export const MAX_DOCUMENTS = 50;

/** Longest passage text returned per document. */
export const MAX_DOCUMENT_TEXT = 2000;
