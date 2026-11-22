import { isRecord, parseJsonString } from './parse-json-string';
import { MAX_DOCUMENTS, MAX_DOCUMENT_TEXT, type ExtractedDocument } from './retrieval.types';

/** Object fields that may hold the list of documents, checked in this order. */
export const LIST_FIELDS = ['documents', 'results', 'matches', 'hits', 'nodes', 'chunks', 'items'] as const;

/**
 * Paths to a document's passage text; the first non-empty string wins. `name` and
 * `description` are deliberately absent: a SQL tool's `[{"name": "Aeron Chair", …}]`
 * would otherwise show as a search (phase-3 FAQ Q52).
 */
const TEXT_PATHS: ReadonlyArray<readonly string[]> = [
  ['text'],
  ['content'],
  ['page_content'],
  ['pageContent'],
  ['body'],
  ['chunk'],
  ['snippet'],
  ['passage'],
  ['document'],
  ['node', 'text'],
  ['metadata', 'text'],
];

/** How many leading items decide whether a list is a list of documents. */
export const SAMPLE_SIZE = 20;

/** Reads a nested field, decoding a JSON-string object on the way. */
function at(item: Record<string, unknown>, path: readonly string[]): unknown {
  let cur: unknown = item;
  for (const key of path) {
    const obj = parseJsonString(cur);
    if (!isRecord(obj)) return undefined;
    cur = obj[key];
  }
  return cur;
}

/** Keys a bare MCP-style text content part may carry besides `type` and `text`. */
const CONTENT_PART_KEYS = new Set(['type', 'text', 'annotations', '_meta']);

/**
 * True for a chat message (`{role, content}`) or a bare text content part (`{type: 'text',
 * text}`). Both carry a text field, but a tool that returns them is not returning
 * documents, so they never count toward the shape check.
 */
function isMessageLike(item: Record<string, unknown>): boolean {
  if (typeof item.role === 'string') return true;
  return item.type === 'text' && Object.keys(item).every((k) => CONTENT_PART_KEYS.has(k));
}

/** The item's passage text, or null when it has none or is a message (see {@link isMessageLike}). */
function textOf(item: unknown): string | null {
  if (!isRecord(item) || isMessageLike(item)) return null;
  for (const path of TEXT_PATHS) {
    const value = at(item, path);
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/** The first finite number among `keys`. */
function numberOf(obj: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/** The first non-empty string (or number, stringified) among `keys`. */
function stringOf(obj: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return null;
}

/** Finds the candidate list: the value itself, or its first list-valued field. */
function findList(output: unknown): unknown[] | null {
  if (Array.isArray(output)) return output;
  if (!isRecord(output)) return null;
  for (const field of LIST_FIELDS) {
    const value = parseJsonString(output[field]);
    if (Array.isArray(value)) return value;
  }
  return null;
}

/** Normalises one document item; `text` is its passage, or `''` for an id-only item. */
function toDocument(item: Record<string, unknown>, text: string): ExtractedDocument {
  const node = isRecord(item.node) ? item.node : null;
  const rawMeta = parseJsonString(item.metadata ?? node?.metadata);
  const metadata = isRecord(rawMeta) ? rawMeta : null;
  const truncated = text.length > MAX_DOCUMENT_TEXT;
  return {
    id: stringOf(item, 'id', 'doc_id', 'document_id', '_id') ?? stringOf(node, 'id_', 'id') ?? stringOf(metadata, 'id', 'doc_id'),
    text: truncated ? text.slice(0, MAX_DOCUMENT_TEXT) : text,
    score: numberOf(item, 'score', 'similarity', 'relevance_score', 'distance', '_score'),
    source:
      stringOf(metadata, 'source', 'url', 'file_name', 'title') ?? stringOf(item, 'source', 'url', 'title'),
    metadata,
    truncated,
  };
}

/**
 * Reads a list of documents out of a step's output, when the output is one.
 *
 * The output (or a JSON string of it) must be a list, or an object holding one in a
 * field such as `documents` or `matches`. It counts as documents when at least half of
 * its first {@link SAMPLE_SIZE} items are objects with passage text (see
 * {@link TEXT_PATHS}). Items without text are skipped.
 *
 * @param output - A span's captured output, in any shape.
 * @returns At most {@link MAX_DOCUMENTS} documents plus the uncapped count, `[]` for an
 *   empty list, or null when the output is not a list of documents.
 */
export function extractDocuments(output: unknown): { documents: ExtractedDocument[]; count: number } | null {
  const list = findList(parseJsonString(output));
  if (!list) return null;
  if (list.length === 0) return { documents: [], count: 0 };

  const sample = list.slice(0, SAMPLE_SIZE);
  const withText = sample.filter((item) => textOf(parseJsonString(item)) !== null).length;
  if (withText === 0 || withText * 2 < sample.length) return null;

  const documents: ExtractedDocument[] = [];
  let count = 0;
  for (const raw of list) {
    const item = parseJsonString(raw);
    const text = textOf(item);
    if (text === null || !isRecord(item)) continue;
    count++;
    if (documents.length < MAX_DOCUMENTS) documents.push(toDocument(item, text));
  }
  return { documents, count };
}

/**
 * One passage as a document with no id: an id would be invented, and repeats then match
 * by text.
 *
 * @param text - The passage; cut to {@link MAX_DOCUMENT_TEXT} characters.
 * @returns The document, with `truncated` set when the text was cut.
 */
export function textDocument(text: string): ExtractedDocument {
  const truncated = text.length > MAX_DOCUMENT_TEXT;
  return { id: null, text: truncated ? text.slice(0, MAX_DOCUMENT_TEXT) : text, score: null, source: null, metadata: null, truncated };
}

/**
 * Reads documents from shapes {@link extractDocuments} rejects, for a step already known
 * to be a search (a `retrieval` span or a tool marked `kind="retrieval"`): a list of
 * strings, one document each, or a list of objects that carry an id but no passage text,
 * such as GenAI `{id, score}` items. Never used for the shape check, where these shapes
 * are too common in non-search tools to be evidence.
 *
 * @param output - A search step's captured output.
 * @returns At most {@link MAX_DOCUMENTS} documents plus the uncapped count, or null when
 *   the output is neither shape.
 */
export function extractLooseDocuments(output: unknown): { documents: ExtractedDocument[]; count: number } | null {
  const list = findList(parseJsonString(output));
  if (!list || list.length === 0) return null;
  if (list.every((item) => typeof item === 'string')) {
    const passages = (list as string[]).filter((t) => t.trim() !== '');
    return { documents: passages.slice(0, MAX_DOCUMENTS).map(textDocument), count: passages.length };
  }
  const items = list.map((raw) => parseJsonString(raw));
  const withId = items.filter(
    (item): item is Record<string, unknown> => isRecord(item) && stringOf(item, 'id', 'doc_id', 'document_id', '_id') !== null,
  );
  if (withId.length * 2 < items.length || withId.length === 0) return null;
  return { documents: withId.slice(0, MAX_DOCUMENTS).map((item) => toDocument(item, '')), count: withId.length };
}
