/** Placeholder substituted for any matched secret-shaped substring. */
const REDACTED = '[REDACTED]';

/**
 * Common secret shapes worth scrubbing from captured span payload content.
 *
 * Order matters, and it runs widest-match-first: `Bearer <token>` is replaced whole so
 * the placeholder reads `Authorization: [REDACTED]` rather than leaving a bare `Bearer `
 * behind, and an address is replaced whole so a key-shaped local part cannot redact
 * itself and leave `[REDACTED]@example.com` — which publishes the domain. A narrower
 * pattern placed first wins the substring and breaks both.
 *
 * The key patterns carry no leading anchor. `\b` sits between a word and a non-word
 * character, so it does not match *before* a key whose preceding character is itself a
 * word character: `ACRUXCORE_API_KEY_acx_sk_…` or an f-string's `token{key}` left the key
 * entirely in clear text. A negative lookbehind for the same character set is not a fix —
 * it restates the same restriction. `acx_sk_`/`agh_sk_` are distinctive enough literals
 * that dropping the anchor costs nothing; the prefix before the key is simply left alone,
 * so the result reads `ACRUXCORE_API_KEY_[REDACTED]`. The trailing side needs no anchor
 * either — the character class is already bounded.
 *
 * `sk-` is too short to go unanchored (`multitask-oriented-approach` contains it), so it
 * keeps `(?<![A-Za-z0-9])`: that still rejects a match inside a word while allowing the
 * `OPENAI_API_KEY_sk-…` shape, which `\b` rejected.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._-]+/gi, // Authorization: Bearer <token>
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // email addresses
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style secret keys
  // Both of this project's own key formats. The body is `randomBytes(30)` encoded
  // as base64url (`api-keys.crypto.ts`, `keys.crypto.ts`), so it contains `-` and
  // `_` — a `[A-Za-z0-9]` class stopped at the first of those and left most of a
  // real key in clear text, and `agh_sk_` had no pattern at all.
  /acx_sk_[A-Za-z0-9_-]{16,}/g, // platform API keys
  /agh_sk_[A-Za-z0-9_-]{16,}/g, // gateway virtual keys
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}\b/g, // AWS access key ids
];

/** Applies every {@link SECRET_PATTERNS} entry to a single string, in order. */
function redactString(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/**
 * Best-effort, pattern-based scrub of common secret shapes (API keys, bearer
 * tokens, email addresses) from arbitrary JSON before it is persisted as a
 * span payload (Finding #7). Deliberately incomplete — it cannot catch every
 * secret shape a prompt or completion might embed — so the payload retention
 * purge job is the primary control here; this is defense in depth only.
 *
 * @param value - Arbitrary JSON-serializable value (span input/output/variables).
 * @returns A deep copy of `value` with matched substrings replaced by `[REDACTED]`;
 *   non-string primitives and `null` pass through unchanged.
 */
export function redactPayloadValue<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactPayloadValue(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactPayloadValue(v);
    }
    return out as unknown as T;
  }
  return value;
}
