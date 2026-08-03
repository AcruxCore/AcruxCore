import type { ChatMessage } from '../../gateway/providers/types';
import { extractVariables } from '../../prompts/versions/nunjucks.utils';
import { OptimizeResultSchema } from './optimize.types';

/** The only escapes JSON allows after a backslash inside a string literal. */
const LEGAL_JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

/**
 * Repair the two ways an LLM most often emits *nearly* valid JSON, so one bad
 * character does not cost a whole optimize run.
 *
 * Both are strictly inside string literals and both are unambiguous to fix:
 *
 * 1. **An illegal escape.** A model asked to write prose containing an
 *    apostrophe returns `customer\'s`, and `\'` is not in JSON's escape set, so
 *    `JSON.parse` rejects the entire document. Observed for real: an optimize
 *    run failed with three good rewrites in hand because of one apostrophe.
 *    The backslash is dropped and the character kept.
 * 2. **A raw control character.** A rewritten prompt template naturally spans
 *    lines, and a literal newline inside a JSON string is illegal. It is
 *    converted to its proper escape.
 *
 * Structure is never touched — quotes, braces and commas outside string
 * literals pass through untouched, so this cannot turn one JSON document into a
 * different valid one. Call it only after a plain `JSON.parse` has already
 * failed.
 *
 * @param json - A JSON document that failed to parse.
 * @returns The repaired text, to be parsed again (it may still be invalid).
 */
function repairJsonStringEscapes(json: string): string {
  let out = '';
  let inString = false;

  for (let i = 0; i < json.length; i++) {
    const char = json[i]!;

    if (!inString) {
      out += char;
      if (char === '"') inString = true;
      continue;
    }

    if (char === '\\') {
      const next = json[i + 1];
      if (next !== undefined && LEGAL_JSON_ESCAPES.has(next)) {
        out += char + next;
        i++;
      } else if (next !== undefined) {
        // Illegal escape such as `\'` — keep the character, drop the backslash.
        out += next;
        i++;
      } else {
        out += char;
      }
      continue;
    }

    if (char === '"') {
      out += char;
      inString = false;
      continue;
    }

    const code = char.charCodeAt(0);
    if (code < 0x20) {
      out +=
        char === '\n'
          ? '\\n'
          : char === '\r'
            ? '\\r'
            : char === '\t'
              ? '\\t'
              : `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }

    out += char;
  }

  return out;
}

/**
 * Extract and parse the optimizer LLM's JSON response, dropping any
 * candidate whose rewritten template fails to parse.
 *
 * Locates the first balanced `{...}` in the raw text (string-aware brace
 * scan — braces inside JSON string literals, including a stray `}` inside
 * a `rationale` string, are ignored; backslash escapes inside a string are
 * skipped over rather than interpreted as delimiters), parses it as JSON,
 * validates the shape with `OptimizeResultSchema`, then validates each
 * candidate's `messages` actually parse as a valid nunjucks template via
 * `extractVariables` — any candidate whose template is malformed is
 * dropped rather than surfacing the parse error. When `originalVariables` is
 * supplied, a candidate whose variable set doesn't match it EXACTLY (missing
 * or invented `{{ variable }}`) is also dropped (Finding #17) — the
 * optimizer's "rewrite the wording, keep the variables" contract isn't
 * actually enforced by template-parse validity alone, since a syntactically
 * valid rewrite can still silently drop or invent a variable. Surviving
 * candidates are capped (not padded) to `draftCount`.
 *
 * @param raw - Raw text from the optimizer LLM, which may contain
 *   surrounding prose around the JSON payload.
 * @param draftCount - Maximum number of candidates to return.
 * @param originalVariables - The variable set the rewrite must match exactly
 *   (order-independent). Omit to skip this check (e.g. a caller with no
 *   original template to compare against).
 * @returns Surviving candidates (each with `messages`/`rationale`), or `[]`
 *   if the input is not valid JSON, does not match the expected shape, or
 *   no candidate survives validation.
 */
export function parseCandidates(
  raw: string,
  draftCount: number,
  originalVariables?: string[],
): Array<{ messages: ChatMessage[]; rationale: string }> {
  return parseCandidatesDetailed(raw, draftCount, originalVariables).candidates;
}

/**
 * Same parse as {@link parseCandidates}, but also reports why candidates were
 * dropped.
 *
 * Exists so a failed optimize run can say what actually happened. "Optimizer
 * produced no valid candidates" is true of two very different situations — the
 * model returned unusable text, or it returned three good rewrites that were all
 * rejected on a variable-set mismatch — and the second one looked, from the
 * outside, exactly like the model having a bad day. It was really the prompt's
 * own shape example telling the model to omit the message holding the variables.
 *
 * @param raw - Raw text from the optimizer LLM.
 * @param draftCount - Maximum number of candidates to return.
 * @param originalVariables - The variable set the rewrite must match exactly.
 * @returns `{ candidates, rejections }` — `rejections` holds one human-readable
 *   reason per dropped candidate, in the order they appeared, and is empty when
 *   nothing was dropped.
 */
export function parseCandidatesDetailed(
  raw: string,
  draftCount: number,
  originalVariables?: string[],
): { candidates: Array<{ messages: ChatMessage[]; rationale: string }>; rejections: string[] } {
  const rejections: string[] = [];
  // Find the first '{' character.
  const startIdx = raw.indexOf('{');
  if (startIdx === -1) {
    return { candidates: [], rejections: ['optimizer response contained no JSON object'] };
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
    return { candidates: [], rejections: ['optimizer response had an unterminated JSON object'] };
  }

  // Extract the JSON substring.
  const jsonStr = raw.substring(startIdx, endIdx + 1);

  // Try to parse as JSON.
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // One retry through the escape repair — an illegal `\'` or a raw newline
    // inside a string is a whole run lost for a single character otherwise.
    try {
      parsed = JSON.parse(repairJsonStringEscapes(jsonStr));
    } catch {
      return { candidates: [], rejections: ['optimizer response was not valid JSON'] };
    }
  }

  // Validate basic shape.
  const parseResult = OptimizeResultSchema.safeParse(parsed);
  if (!parseResult.success) {
    return {
      candidates: [],
      rejections: ['optimizer JSON did not match the expected {candidates:[{messages,rationale}]} shape'],
    };
  }

  const originalSet = originalVariables ? new Set(originalVariables) : undefined;

  // Drop any candidate whose rewritten template fails to parse, or (Finding
  // #17) whose variable set doesn't exactly match the original template's.
  const survivors: Array<{ messages: ChatMessage[]; rationale: string }> = [];
  for (const [idx, candidate] of parseResult.data.candidates.entries()) {
    let candidateVars: string[];
    try {
      candidateVars = extractVariables(candidate.messages);
    } catch {
      // Malformed template (NunjucksParseError) — drop this candidate.
      rejections.push(`candidate ${idx + 1}: template does not parse as a valid nunjucks template`);
      continue;
    }
    if (originalSet) {
      const candidateSet = new Set(candidateVars);
      const matches =
        candidateSet.size === originalSet.size && [...originalSet].every((v) => candidateSet.has(v));
      if (!matches) {
        // dropped or invented a variable
        const missing = [...originalSet].filter((v) => !candidateSet.has(v));
        const invented = [...candidateSet].filter((v) => !originalSet.has(v));
        const parts = [
          missing.length ? `dropped {{ ${missing.join(' }}, {{ ')} }}` : '',
          invented.length ? `invented {{ ${invented.join(' }}, {{ ')} }}` : '',
        ].filter(Boolean);
        rejections.push(
          `candidate ${idx + 1}: ${parts.join('; ')} (a rewrite must keep exactly the original variables)`,
        );
        continue;
      }
    }
    survivors.push({
      messages: candidate.messages as ChatMessage[],
      rationale: candidate.rationale,
    });
  }

  // Cap (don't pad) to draftCount.
  return { candidates: survivors.slice(0, draftCount), rejections };
}
