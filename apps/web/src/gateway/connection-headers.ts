/**
 * The "Extra headers" field of an OpenAI-compatible credential, as text: one
 * `Name: value` per line. The API makes the final check (which names are refused, and
 * why); this only turns the text into the object it expects and catches typing mistakes
 * before a round trip.
 */

/** An RFC 9110 header name, the same rule the API applies. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** Result of {@link parseHeaderLines}: the headers, or the first problem found. */
export type ParsedHeaders = { ok: true; headers: Record<string, string> } | { ok: false; error: string };

/**
 * Parses `Name: value` lines. Blank lines are skipped; the value is everything after the
 * first colon, trimmed, so a value may itself hold a colon.
 *
 * @param text - The field's contents.
 * @returns The headers (empty when the field is blank), or the first line's problem,
 *   including a name repeated in another case.
 */
export function parseHeaderLines(text: string): ParsedHeaders {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return { ok: false, error: `Line ${i + 1}: write it as Name: value.` };
    const name = line.slice(0, colon).trim();
    if (!HEADER_NAME.test(name)) return { ok: false, error: `Line ${i + 1}: "${name}" is not a valid header name.` };
    // HTTP names ignore case, and fetch would join the two values into one.
    if (seen.has(name.toLowerCase())) {
      return { ok: false, error: `Line ${i + 1}: ${name.toLowerCase()} is already set on an earlier line. Header names ignore case.` };
    }
    seen.add(name.toLowerCase());
    headers[name] = line.slice(colon + 1).trim();
  }
  return { ok: true, headers };
}

/**
 * Writes stored headers back as field text, one `Name: value` per line.
 *
 * @param headers - A connection's `config.headers`; anything that is not a string map
 *   gives an empty field.
 * @returns The field text.
 */
export function formatHeaderLines(headers: unknown): string {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return '';
  return Object.entries(headers as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string')
    .map(([k, v]) => `${k}: ${v as string}`)
    .join('\n');
}
