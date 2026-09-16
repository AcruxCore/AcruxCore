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

/**
 * nunjucks exposes its parser and node constructors on the browser bundle too, so the
 * Preview reads the SAME AST the server does. The previous regex approximation is gone
 * on purpose: it was a second implementation of one rule, it drifted from the server's,
 * and it reproduced the server's own scoping bug independently (issue #503).
 */
const parser = (nunjucks as unknown as {
  parser: { parse(src: string, extensions: unknown[], opts: object): unknown };
}).parser;
const njNodes = (nunjucks as unknown as {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodes: Record<string, new (...args: any[]) => object>;
}).nodes;

/** Frames of names bound by an enclosing construct, innermost last. */
type ScopeStack = Array<Set<string>>;

// Adds the Symbol name(s) rooted at `node` — a single Symbol, or a nunjucks
// Array/NodeList of them ({% for k, v in items %}, a macro's argument list).
function addSymbolNames(node: unknown, bound: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (njNodes['Symbol'] && node instanceof njNodes['Symbol']) {
    bound.add((node as Record<string, unknown>)['value'] as string);
    return;
  }
  const children = (node as Record<string, unknown>)['children'];
  if (Array.isArray(children)) children.forEach((c) => addSymbolNames(c, bound));
}

// True when any enclosing frame binds `name`, so it is not an input the user must supply.
function isBound(name: string, scopes: ScopeStack): boolean {
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i]!.has(name)) return true;
  }
  return false;
}

/**
 * Collects the names a template needs, tracking scope as it walks.
 *
 * Mirrors `extractVariables` in `apps/api/src/prompts/versions/nunjucks.utils.ts`,
 * which stays the authoritative version — a committed prompt's required list is the
 * server's. `{% for %}` binds its target over its own body only, so a name used before
 * the loop, after `{% endfor %}`, or in the `{% else %}` branch is a real input.
 */
function walkAst(node: unknown, vars: Set<string>, scopes: ScopeStack): void {
  if (!node || typeof node !== 'object') return;
  const rec = node as Record<string, unknown>;

  if (njNodes['For'] && node instanceof njNodes['For']) {
    walkAst(rec['arr'], vars, scopes); // the sequence is read outside the loop's scope
    const frame = new Set<string>();
    addSymbolNames(rec['name'], frame);
    scopes.push(frame);
    walkAst(rec['body'], vars, scopes);
    scopes.pop();
    // `{% else %}` runs when the sequence was empty, so nothing is bound there.
    walkAst(rec['else_'], vars, scopes);
    return;
  }

  if (njNodes['Macro'] && node instanceof njNodes['Macro']) {
    const frame = new Set<string>();
    addSymbolNames(rec['args'], frame);
    scopes.push(frame);
    walkAst(rec['body'], vars, scopes);
    scopes.pop();
    return;
  }

  if (njNodes['Set'] && node instanceof njNodes['Set']) {
    walkAst(rec['value'], vars, scopes); // `{% set total = price %}` still needs `price`
    walkAst(rec['body'], vars, scopes); // the {% set x %}…{% endset %} block form
    const targets = rec['targets'];
    if (Array.isArray(targets)) targets.forEach((t) => addSymbolNames(t, scopes[scopes.length - 1]!));
    return;
  }

  // Attribute access: {{ user.name }} — capture root `user` only.
  if (njNodes['LookupVal'] && node instanceof njNodes['LookupVal']) {
    const target = rec['target'];
    if (target && njNodes['Symbol'] && target instanceof njNodes['Symbol']) {
      const name = (target as Record<string, unknown>)['value'] as string;
      if (!isBound(name, scopes)) vars.add(name);
    }
    return;
  }

  if (njNodes['Symbol'] && node instanceof njNodes['Symbol']) {
    const name = rec['value'] as string;
    if (!isBound(name, scopes)) vars.add(name);
    return;
  }

  for (const key of Object.keys(node as object)) {
    if (key === 'parent') continue; // avoid circular refs
    const child = rec[key];
    if (Array.isArray(child)) child.forEach((c) => walkAst(c, vars, scopes));
    else if (child && typeof child === 'object') walkAst(child, vars, scopes);
  }
}

/**
 * The variables a draft needs, for the live Preview's input fields.
 *
 * A preview aid, not validation: the authoritative list for a committed version is the
 * server-extracted `variables[]`. Scope is per message and per block — `renderMessages`
 * renders each message as its own template, so a binding in one message has no scope in
 * any other, and inside a message `{% for %}` binds only over its own body.
 *
 * A message that does not parse contributes nothing, which is what happens while
 * someone is still typing a tag. The other messages keep their fields.
 *
 * @param messages - The draft messages being edited.
 * @returns Sorted, de-duplicated variable names.
 */
export function extractVariables(messages: Message[]): string[] {
  const vars = new Set<string>();

  for (const message of messages) {
    let ast: unknown;
    try {
      ast = parser.parse(message.content, [], {});
    } catch {
      continue; // half-typed template; the next keystroke will parse
    }
    // A fresh stack per message, with one root frame for a top-level `{% set %}`.
    walkAst(ast, vars, [new Set<string>()]);
  }

  return [...vars].sort();
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
