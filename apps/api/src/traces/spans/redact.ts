/** Placeholder substituted for any matched secret-shaped substring. */
const REDACTED = '[REDACTED]';

/**
 * Common secret shapes worth scrubbing from captured span payload content.
 * Order matters: `Bearer <token>` is matched (and replaced) whole so the
 * placeholder reads "Authorization: [REDACTED]" rather than leaving a bare
 * "Bearer " prefix behind once the token itself is later stripped.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style secret keys
  /\bacx_sk_[A-Za-z0-9]{16,}\b/g, // this project's own API keys (acx_sk_ + hash)
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bBearer\s+[A-Za-z0-9._-]+\b/gi, // Authorization: Bearer <token>
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // email addresses
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
