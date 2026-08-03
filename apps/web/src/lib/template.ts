import nunjucks from 'nunjucks';
import type { Message } from '@/api/types';

/**
 * A nunjucks environment for client-side Preview rendering.
 *
 * `autoescape` is off because prompts are plain text, not HTML, and undefined
 * variables render as empty (not throwing) so a partially-filled preview still
 * works. This mirrors the Jinja2-compatible engine the backend uses.
 */
const env = new nunjucks.Environment(null, {
  autoescape: false,
  throwOnUndefined: false,
});

const KEYWORDS = new Set([
  'true', 'false', 'none', 'null', 'and', 'or', 'not', 'in', 'is',
  'if', 'else', 'elif', 'for', 'endfor', 'endif', 'set', 'endset',
  'loop', 'range', 'length', 'block', 'endblock',
]);

/**
 * Extract the root identifiers appearing in a nunjucks expression, ignoring
 * string literals, filter names, property access, and keywords.
 *
 * @param expr - The raw expression text between delimiters.
 * @returns Root identifier names in appearance order (may contain duplicates).
 */
function idsIn(expr: string): string[] {
  const cleaned = expr
    .replace(/"[^"]*"|'[^']*'/g, ' ') // drop string literals
    .replace(/\|\s*[A-Za-z_]\w*/g, ' '); // drop filter names after `|`
  const ids: string[] = [];
  const re = /[A-Za-z_]\w*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    // Skip property access (`user.name` → keep `user`, drop `name`).
    if (m.index > 0 && cleaned[m.index - 1] === '.') continue;
    if (KEYWORDS.has(m[0])) continue;
    ids.push(m[0]);
  }
  return ids;
}

/**
 * Approximate the set of variables a template needs, for the live Preview's
 * input fields. This is a preview aid, not validation: the authoritative list
 * for a committed version is the server-extracted `variables[]`. Handles the
 * common cases — `{{ x }}`, `{{ user.name }}`, `{% if x %}`, `{% for a in b %}`,
 * `{% set y = ... %}` — treating loop/set targets as locals, not inputs.
 *
 * @param messages - The draft messages being edited.
 * @returns Sorted, de-duplicated variable names.
 */
export function extractVariables(messages: Message[]): string[] {
  const text = messages.map((m) => m.content).join('\n');
  const found = new Set<string>();
  const locals = new Set<string>();

  // `{% for X[, Y] in Z %}` — X/Y are locals, Z is a source.
  const forRe = /\{%-?\s*for\s+([\w,\s]+?)\s+in\s+([^%]+?)-?%\}/g;
  let fm: RegExpExecArray | null;
  while ((fm = forRe.exec(text)) !== null) {
    fm[1].split(',').forEach((v) => locals.add(v.trim()));
    idsIn(fm[2]).forEach((v) => found.add(v));
  }

  // `{% set X = ... %}` — X is a local.
  const setRe = /\{%-?\s*set\s+(\w+)\s*=([^%]+?)-?%\}/g;
  let sm: RegExpExecArray | null;
  while ((sm = setRe.exec(text)) !== null) {
    locals.add(sm[1].trim());
    idsIn(sm[2]).forEach((v) => found.add(v));
  }

  // `{% if / elif COND %}`
  const ifRe = /\{%-?\s*(?:if|elif)\s+([^%]+?)-?%\}/g;
  let im: RegExpExecArray | null;
  while ((im = ifRe.exec(text)) !== null) {
    idsIn(im[1]).forEach((v) => found.add(v));
  }

  // `{{ expr }}`
  const outRe = /\{\{-?\s*([^}]+?)\s*-?\}\}/g;
  let om: RegExpExecArray | null;
  while ((om = outRe.exec(text)) !== null) {
    idsIn(om[1]).forEach((v) => found.add(v));
  }

  return [...found].filter((v) => !locals.has(v)).sort();
}

/**
 * Render each message's content with the provided variable values.
 *
 * @param messages - Draft messages containing nunjucks templates.
 * @param values - Variable name → value map.
 * @returns Rendered messages (same roles, substituted content).
 * @throws {Error} If a template has a syntax error nunjucks cannot parse.
 */
export function renderMessages(
  messages: Message[],
  values: Record<string, unknown>,
): Message[] {
  return messages.map((m) => ({
    role: m.role,
    content: env.renderString(m.content, values),
  }));
}
