import { VerdictSchema, type Verdict } from './judge.types';

/**
 * Extract and parse a JSON verdict from raw text, handling surrounding prose.
 *
 * Locates the first balanced `{...}` in the input, parses it as JSON,
 * validates the shape with VerdictSchema, and clamps the score to [0, 100].
 *
 * @param raw - Raw text that may contain JSON plus surrounding content.
 * @returns A validated Verdict with clamped score, or null if parsing/validation fails.
 */
export function parseVerdict(raw: string): Verdict | null {
  // Find the first '{' character.
  const startIdx = raw.indexOf('{');
  if (startIdx === -1) {
    return null;
  }

  // Scan for the matching closing '}' at depth 0, string-aware: braces inside
  // JSON string literals are ignored, and backslash escapes inside a string
  // (e.g. `\"`, `\\`) are skipped over rather than interpreted as delimiters.
  let depth = 0;
  let endIdx = -1;
  let inString = false;
  for (let i = startIdx; i < raw.length; i++) {
    const char = raw[i];

    if (inString) {
      if (char === '\\') {
        // Skip the escaped character entirely — it can't toggle in-string
        // state or count as a brace, regardless of what it is.
        i++;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }

  if (endIdx === -1) {
    // No matching closing brace found.
    return null;
  }

  // Extract the JSON substring.
  const jsonStr = raw.substring(startIdx, endIdx + 1);

  // Try to parse as JSON.
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  // Validate basic shape; fails only if score/passed/reason have the wrong
  // type — range is NOT enforced here, it's clamped explicitly below.
  const parseResult = VerdictSchema.safeParse(parsed);
  if (!parseResult.success) {
    return null;
  }

  // Clamp the score to [0, 100] and round to nearest integer.
  const verdict = parseResult.data;
  const clampedScore = Math.round(Math.max(0, Math.min(100, verdict.score)));

  return {
    score: clampedScore,
    passed: verdict.passed,
    reason: verdict.reason,
  };
}
