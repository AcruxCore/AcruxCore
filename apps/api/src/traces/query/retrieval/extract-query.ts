import { isRecord, parseJsonString } from './parse-json-string';

/** Argument names that hold the search text, checked in this order. */
const QUERY_KEYS = ['query', 'q', 'question', 'search_query', 'query_text', 'input', 'text'] as const;

/**
 * Reads what a search step searched for from its captured input.
 *
 * A string input is the query itself (OpenInference `input.value`, GenAI
 * `gen_ai.retrieval.query.text`). An object input uses its `query`, `q`, `question`,
 * `search_query`, `query_text`, `input` or `text` argument, else its only string
 * argument.
 *
 * @param input - A span's captured input, in any shape.
 * @returns The query text, or null when the input names none (or names two candidates).
 */
export function extractQuery(input: unknown): string | null {
  const value = parseJsonString(input);
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (!isRecord(value)) return null;

  for (const key of QUERY_KEYS) {
    const v = value[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  const strings = Object.values(value).filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return strings.length === 1 ? strings[0] : null;
}
