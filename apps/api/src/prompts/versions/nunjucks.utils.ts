import * as nunjucks from 'nunjucks';
import ivm from 'isolated-vm';
import { readFileSync } from 'node:fs';

// ── Error classes ─────────────────────────────────────────────────────────────

/**
 * Thrown when a nunjucks template string fails to parse (syntax error).
 * Wraps the original nunjucks error so callers can extract message text.
 */
export class NunjucksParseError extends Error {
  public readonly original: unknown;

  constructor(message: string, original: unknown) {
    super(message);
    this.name = 'NunjucksParseError';
    this.original = original;
  }
}

/**
 * Thrown when nunjucks fails to render a template at runtime
 * (e.g. calling an undefined filter on a variable).
 */
export class NunjucksRenderError extends Error {
  public readonly original: unknown;

  constructor(message: string, original: unknown) {
    super(message);
    this.name = 'NunjucksRenderError';
    this.original = original;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single message in the OpenAI chat format with a raw nunjucks content string. */
export interface MessageInput {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** A rendered message with all template variables replaced. */
export interface RenderedMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ── AST walker ────────────────────────────────────────────────────────────────

// nunjucks.nodes types are not fully exposed — cast to access Symbol/LookupVal constructors.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const njNodes = (nunjucks as unknown as { nodes: Record<string, new (...args: any[]) => object> }).nodes;

// Adds the Symbol name(s) rooted at `node` to `bound` — handles a single
// Symbol ({% for x in y %}) and a nunjucks Array/NodeList of Symbols
// ({% for k, v in items %}, or comma-separated {% set %} targets).
function addSymbolNames(node: unknown, bound: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (njNodes['Symbol'] && node instanceof njNodes['Symbol']) {
    bound.add((node as Record<string, unknown>)['value'] as string);
    return;
  }
  const children = (node as Record<string, unknown>)['children'];
  if (Array.isArray(children)) {
    children.forEach((c) => addSymbolNames(c, bound));
  }
}

// Walks the whole AST collecting every name bound by a {% for %} loop target
// or a {% set %} target. These shadow any outer variable of the same name
// within their scope and must not be treated as caller-supplied inputs.
function collectBoundNames(node: unknown, bound: Set<string>): void {
  if (!node || typeof node !== 'object') return;

  if (njNodes['For'] && node instanceof njNodes['For']) {
    addSymbolNames((node as Record<string, unknown>)['name'], bound);
  } else if (njNodes['Set'] && node instanceof njNodes['Set']) {
    const targets = (node as Record<string, unknown>)['targets'];
    if (Array.isArray(targets)) {
      targets.forEach((t) => addSymbolNames(t, bound));
    }
  }

  for (const key of Object.keys(node as object)) {
    if (key === 'parent') continue; // avoid circular refs
    const child = (node as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      child.forEach((c) => collectBoundNames(c, bound));
    } else if (child && typeof child === 'object') {
      collectBoundNames(child, bound);
    }
  }
}

// Walks a nunjucks AST node and collects all referenced top-level variable names.
// Handles simple {{ name }} and attribute access {{ user.name }} (captures root 'user').
// `bound` holds loop/set target names (see collectBoundNames) that shadow an
// outer variable of the same name and so are never captured as inputs.
function walkAst(node: unknown, vars: Set<string>, bound: Set<string>): void {
  if (!node || typeof node !== 'object') return;

  // Attribute access: {{ user.name }} — capture root 'user' only
  if (njNodes['LookupVal'] && node instanceof njNodes['LookupVal']) {
    const target = (node as Record<string, unknown>)['target'];
    if (target && njNodes['Symbol'] && target instanceof njNodes['Symbol']) {
      const name = (target as Record<string, unknown>)['value'] as string;
      if (!bound.has(name)) vars.add(name);
    }
    // Don't descend into LookupVal — we already captured the root
    return;
  }

  // Simple variable reference: {{ name }}
  if (njNodes['Symbol'] && node instanceof njNodes['Symbol']) {
    const name = (node as Record<string, unknown>)['value'] as string;
    if (!bound.has(name)) vars.add(name);
    return;
  }

  for (const key of Object.keys(node as object)) {
    if (key === 'parent') continue; // avoid circular refs
    const child = (node as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      child.forEach((c) => walkAst(c, vars, bound));
    } else if (child && typeof child === 'object') {
      walkAst(child, vars, bound);
    }
  }
}

// ── Sandbox ───────────────────────────────────────────────────────────────────

// nunjucks ships its own dependency-free browser bundle (no fs/require/other
// Node built-ins — built for running in a plain JS environment like a
// browser). Loaded once and reused as the bootstrap script for every render
// isolate below, so no bundler step is needed to get nunjucks running inside
// a bare V8 context.

/**
 * Reads the nunjucks browser bundle from disk so it can be used as the
 * bootstrap script for every sandboxed render isolate. Pulled out of the
 * top-level module body (rather than an inline `readFileSync(...)` statement)
 * so a missing/relocated file — e.g. a future nunjucks version bump that
 * changes the browser-bundle path, or a production install step that prunes
 * non-`main`-field files from `node_modules` — fails with a clear, actionable
 * message instead of an uncaught `ENOENT` crashing server startup with no
 * indication of the real cause. This still fails fast at module load (the
 * correct behavior for a genuinely missing dependency); it only replaces the
 * error's clarity, not its timing.
 *
 * @param bundlePath - Absolute path to the bundle file. Defaults to
 *   `require.resolve('nunjucks/browser/nunjucks.js')`; only overridden by
 *   tests exercising the failure path with a deliberately bad path.
 * @returns The bundle's UTF-8 source contents.
 * @throws {Error} A descriptive error naming what failed to load and why
 *   prompt rendering can't initialize, wrapping the original error's message.
 */
export function loadNunjucksBrowserBundle(bundlePath?: string): string {
  try {
    const resolvedPath = bundlePath ?? require.resolve('nunjucks/browser/nunjucks.js');
    return readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    throw new Error(
      'Failed to load bundled nunjucks browser runtime for sandboxed template rendering — ' +
        `check the installed nunjucks package version/path: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const NUNJUCKS_BROWSER_BUNDLE = loadNunjucksBrowserBundle();

// A bit more headroom than the 8MB tools/execute/js-transform.ts uses for a
// JSON transform, since this isolate also has to hold the compiled nunjucks
// bundle itself.
const SANDBOX_MEMORY_LIMIT_MB = 16;
// Per-template render budget: generous for any single real template, tight
// enough to kill a runaway loop fast. Applied to EACH template's own
// `script.run()` call (see renderInSandbox) rather than to the whole batch,
// so a legitimate prompt version with many messages — or one message with an
// ordinary loop over a reasonably large list — isn't penalized by a ceiling
// sized for a single message, while a single malicious/runaway template still
// can't buy extra time by hiding in a large batch.
const SANDBOX_RENDER_TIMEOUT_MS = 250;

/**
 * Renders every template string against the same variables inside a single,
 * disposable `isolated-vm` isolate — no `require`/`process`/filesystem/network
 * reachable from inside it, and memory-capped for the whole isolate. Each
 * template is compiled and run as its OWN script call, with its own
 * {@link SANDBOX_RENDER_TIMEOUT_MS} wall-clock timeout enforced by V8 itself
 * (kills a genuine infinite loop, unlike a cooperative check) — the isolate
 * and its `nunjucks.Environment` are reused across the batch (isolate/context
 * creation is the expensive part), but the timeout budget is NOT shared
 * across templates, so neither a large batch of legitimate templates nor a
 * single runaway one can affect the other's time budget. A fresh isolate is
 * created per call and disposed in a `finally`, so no state (and no runaway
 * loop) can outlive or leak between calls or across tenants.
 *
 * @param templates - Raw nunjucks template strings to render, in order.
 * @param variables - Key-value map of variable values to inject.
 * @returns The rendered output strings, in the same order as `templates`.
 * @throws {Error} If any template fails to render, or the isolate's per-template
 *   timeout or overall memory limit is hit — {@link renderMessages} maps this
 *   to {@link NunjucksRenderError}.
 */
async function renderInSandbox(templates: string[], variables: Record<string, unknown>): Promise<string[]> {
  const isolate = new ivm.Isolate({ memoryLimit: SANDBOX_MEMORY_LIMIT_MB });
  try {
    const context = await isolate.createContext();
    const bootstrap = await isolate.compileScript(NUNJUCKS_BROWSER_BUNDLE);
    await bootstrap.run(context);
    await context.global.set('__variables', new ivm.ExternalCopy(variables).copyInto());
    const setupEnv = await isolate.compileScript(
      'const __env = new nunjucks.Environment(null, { autoescape: false });',
    );
    // Not time-limited: this only constructs a nunjucks Environment object,
    // no template content is parsed or executed yet.
    await setupEnv.run(context);

    const rendered: string[] = [];
    for (const template of templates) {
      await context.global.set('__template', new ivm.ExternalCopy(template).copyInto());
      const renderOne = await isolate.compileScript('__env.renderString(__template, __variables);');
      // Each template gets its own fresh timeout window — a slow/malicious
      // template is bounded to SANDBOX_RENDER_TIMEOUT_MS regardless of how
      // many other templates are in this batch, and a big batch of fast,
      // legitimate templates never accumulates toward a shared ceiling.
      rendered.push((await renderOne.run(context, { timeout: SANDBOX_RENDER_TIMEOUT_MS, copy: true })) as string);
    }
    return rendered;
  } finally {
    // Runs on every path (success, thrown error, and timeout) so a runaway
    // isolate never keeps burning CPU/memory in the background afterward.
    isolate.dispose();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parses each message's content as a nunjucks template and extracts all
 * referenced variable names from the AST. Deduplicated and sorted.
 *
 * @param messages - Array of messages whose `content` fields are nunjucks templates.
 * @returns Sorted array of unique variable name strings, e.g. ["company", "name"].
 * @throws {NunjucksParseError} If any content string has invalid nunjucks syntax.
 */
export function extractVariables(messages: Array<{ content: string }>): string[] {
  const vars = new Set<string>();
  const bound = new Set<string>();

  // nunjucks.parser is exported but not typed — cast to access parse()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parser = (nunjucks as unknown as { parser: { parse(src: string, extensions: unknown[], opts: object): unknown } }).parser;

  const asts: unknown[] = [];
  for (const msg of messages) {
    try {
      const ast = parser.parse(msg.content, [], {});
      asts.push(ast);
      collectBoundNames(ast, bound);
    } catch (err) {
      throw new NunjucksParseError(
        `Template parse error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  // Bound names must be known across all messages before the capturing walk,
  // since a loop/set target in one message shadows the same name anywhere else.
  for (const ast of asts) {
    walkAst(ast, vars, bound);
  }

  return Array.from(vars).sort();
}

/**
 * Renders each message's content string by substituting nunjucks variables
 * with the provided values. Returns an OpenAI-compatible messages array.
 *
 * Rendering runs inside an isolated-vm sandbox (see {@link renderInSandbox}):
 * template *content* is attacker-controlled (any team member can commit a
 * prompt version), and nunjucks does not distinguish "look up a variable"
 * from "walk the JS prototype chain and call an arbitrary function" — both
 * are ordinary attribute access to the engine. The sandbox is the actual
 * security boundary; it does not change what legitimate templates can do.
 *
 * @param messages - Messages with raw nunjucks template content.
 * @param variables - Key-value map of variable values to inject.
 * @returns Array of messages with fully rendered content strings.
 * @throws {NunjucksRenderError} If nunjucks encounters a runtime error during
 *   rendering, or the sandbox's timeout/memory limit is hit.
 */
export async function renderMessages(
  messages: MessageInput[],
  variables: Record<string, unknown>,
): Promise<RenderedMessage[]> {
  let rendered: string[];
  try {
    rendered = await renderInSandbox(
      messages.map((msg) => msg.content),
      variables,
    );
  } catch (err) {
    throw new NunjucksRenderError(
      `Template render error: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  return messages.map((msg, i) => ({ role: msg.role, content: rendered[i]! }));
}
