/** Above this length a string is left as text rather than parsed. */
const MAX_PARSE_CHARS = 2_000_000;

/**
 * Decodes a value that may be JSON stored as a string, up to two levels deep. Tool
 * outputs and gateway completions are routinely stored that way. Only a string that
 * parses to an object or an array is replaced; anything else comes back unchanged.
 *
 * @param value - Any captured payload value.
 * @returns The decoded object or array, or `value` itself.
 */
export function parseJsonString(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 2; depth++) {
    if (typeof current !== 'string') return current;
    const trimmed = current.trim();
    const looksLikeJson =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'));
    if (!looksLikeJson || trimmed.length > MAX_PARSE_CHARS) return current;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'string' || (parsed !== null && typeof parsed === 'object')) current = parsed;
      else return current;
    } catch {
      return current;
    }
  }
  return current;
}

/**
 * Narrows a decoded payload value to a plain object before reading its fields.
 *
 * @param value - Any value.
 * @returns True for a plain object; false for an array, null or a scalar.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
