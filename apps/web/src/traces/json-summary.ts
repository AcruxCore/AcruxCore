import { decodePayload } from './format';

/** Longest summary line, so it never wraps in the panel header. */
const MAX_SUMMARY_CHARS = 80;

/** One value inside an object summary: scalars as JSON, containers as a count. */
function brief(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'item' : 'items'}`;
  if (value !== null && typeof value === 'object') {
    const n = Object.keys(value).length;
    return `{${n} ${n === 1 ? 'field' : 'fields'}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

/** Cuts `text` to {@link MAX_SUMMARY_CHARS} with an ellipsis. */
function cut(text: string): string {
  return text.length <= MAX_SUMMARY_CHARS ? text : `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

/**
 * One line that says what a tool returned without opening it: `{price: 120,
 * currency: "USD"}`, `{rooms: 3 items}`, `5 items`, or the text itself.
 *
 * @param value - A span's captured output, possibly JSON stored as a string.
 * @returns A single line of at most 80 characters.
 */
export function summarizeJson(value: unknown): string {
  const decoded = decodePayload(value);
  if (typeof decoded === 'string') return cut(decoded.replace(/\s+/g, ' ').trim());
  if (Array.isArray(decoded)) return brief(decoded);
  if (decoded !== null && typeof decoded === 'object') {
    const fields = Object.entries(decoded).map(([k, v]) => `${k}: ${brief(v)}`);
    return cut(`{${fields.join(', ')}}`);
  }
  return cut(brief(decoded));
}
