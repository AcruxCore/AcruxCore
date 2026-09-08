import type { SpanKind } from '@/api/types';

export { formatUsd, formatCount, formatLatency, formatPercent } from '@/gateway/format';

/** Icon glyph + short label per span kind, for the kind chip in the span tree/table. */
export const KIND_META: Record<SpanKind, { label: string; glyph: string }> = {
  llm: { label: 'LLM', glyph: '◆' },
  tool: { label: 'Tool', glyph: '⚙' },
  retrieval: { label: 'Retrieval', glyph: '⛃' },
  embedding: { label: 'Embedding', glyph: '≋' },
  agent: { label: 'Agent', glyph: '☰' },
  chain: { label: 'Chain', glyph: '⛓' },
  other: { label: 'Other', glyph: '•' },
};

/** Human labels for the feedback `source` enum. */
export const SOURCE_LABELS: Record<string, string> = {
  user: 'User',
  developer: 'Developer',
  end_user: 'End user',
  api: 'API',
};

/**
 * Byline for one feedback row: its source, plus the team member who posted it
 * when there is one.
 *
 * `source` alone says "Developer" but not *which* developer, and that is the
 * thing a reviewer needs when several people triage the same feedback list. A
 * member who never set a display name is shown by email, which is always
 * present. Rows posted with a team-scoped API key or by an end user have no
 * user behind them and keep the bare source label.
 */
export function feedbackByline(source: string, author: { name: string | null; email: string } | null): string {
  const label = SOURCE_LABELS[source] ?? source;
  return author ? `${label} · ${author.name ?? author.email}` : label;
}

/** How deep {@link formatPayload} unwraps JSON that was stored as a string. */
const MAX_UNWRAP_DEPTH = 6;

/** Above this length a string is left alone rather than parsed. */
const MAX_UNWRAP_BYTES = 200_000;

/**
 * Decodes one value that may be JSON hiding inside a string.
 *
 * Only a string parsing to an object or an array is replaced. A string that
 * parses to a number, a boolean or `null` is left exactly as it was: `"12"` is
 * text the caller sent, and turning it into `12` would misreport the payload.
 *
 * @param value - Any value from a captured payload.
 * @param depth - Remaining unwrap budget.
 * @returns The value with string-encoded JSON decoded in place.
 */
function unwrapJsonStrings(value: unknown, depth: number): unknown {
  if (depth <= 0) return value;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const looksLikeJson =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'));
    if (!looksLikeJson || trimmed.length > MAX_UNWRAP_BYTES) return value;
    try {
      return unwrapJsonStrings(JSON.parse(trimmed), depth - 1);
    } catch {
      return value;
    }
  }

  if (Array.isArray(value)) return value.map((v) => unwrapJsonStrings(v, depth - 1));

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        unwrapJsonStrings(v, depth - 1),
      ]),
    );
  }

  return value;
}

/**
 * Renders a captured span payload as text a person can read.
 *
 * Payloads are routinely double-encoded: the stored value is a JSON *string*
 * whose content is itself JSON, and LangChain nests that several levels deep.
 * `JSON.stringify` on one of those produces a single escaped line thousands of
 * characters long — which is why a buried `SystemMessage` was invisible and why
 * "Expand" appeared to do nothing (one line has no height to gain).
 *
 * A plain string that is not JSON is returned as-is, unquoted and unescaped,
 * because wrapping prose in quotes only adds noise.
 *
 * @param value - The captured `input`, `output`, or one attribute value.
 * @returns Pretty-printed text, ready for a `<pre>`.
 */
export function formatPayload(value: unknown): string {
  const decoded = unwrapJsonStrings(value, MAX_UNWRAP_DEPTH);
  if (typeof decoded === 'string') return decoded;
  if (decoded === undefined) return '';
  try {
    return JSON.stringify(decoded, null, 2);
  } catch {
    // A cycle can only arrive from a value we built ourselves, but a payload
    // panel must never be the thing that blanks the page.
    return String(decoded);
  }
}
