import type { ToolSummary } from '@/api';

/**
 * Tool names must match the server's re-validated pattern (letters, digits, `_`/`-`,
 * 1-64 chars). Shared between the create and rename/settings dialogs so a future change
 * to the server's rule needs one edit here, not a hunt for every copy that quietly drifted.
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Narrows the catalog to tools matching a free-text query, against name and description.
 *
 * Client-side rather than a server round-trip because {@link useTools} already holds the
 * whole catalog: filtering locally keeps typing instant and, more importantly, keeps the
 * filtered list and the ids that bindings resolve against as one source.
 *
 * @param tools - The full catalog.
 * @param query - What the user typed; blank returns everything.
 * @returns The matching tools, in the order given.
 */
export function filterTools(tools: ToolSummary[], query: string): ToolSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return tools;
  return tools.filter(
    (t) => t.name.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q),
  );
}

/** How one tool's state reads in a list. */
export interface ToolStatus {
  /** Short label for the badge. */
  label: string;
  /** `warn` for a tool that cannot be called; `default` otherwise. */
  tone: 'warn' | 'default';
  /** A sentence saying what to do next, shown only when the tool is not callable. */
  hint?: string;
}

/**
 * What a tool's readiness should say on a list row.
 *
 * The whole point is that "created" and "callable" are different states and used to look
 * identical. A tool with no version is a name the resolver cannot resolve, so the row has
 * to say so and say what fixes it — not leave the discovery to a prompt that quietly runs
 * with one tool fewer.
 *
 * @param tool - A tool as the list endpoint returns it.
 * @returns The badge to render, plus a next step when there is one.
 */
export function toolStatus(tool: ToolSummary): ToolStatus {
  if (tool.versionCount === 0) {
    return {
      label: 'No version yet',
      tone: 'warn',
      hint: 'Commit a version to define its parameters and executor — until then the model cannot call it.',
    };
  }
  if (!tool.callable) {
    return {
      label: 'Not on production',
      tone: 'warn',
      hint: 'No version is promoted to production, so an unqualified reference cannot resolve it.',
    };
  }
  return {
    label: tool.executorType === 'http' ? 'Runs on AcruxCore' : 'Runs in your code',
    tone: 'default',
  };
}

/**
 * The one-line summary under a tool's name: where production points, and how many
 * versions exist.
 *
 * @param tool - A tool as the list endpoint returns it.
 * @returns A short phrase, or an empty string for a tool with no versions.
 */
export function toolVersionSummary(tool: ToolSummary): string {
  if (tool.versionCount === 0) return '';
  const production = tool.aliases.find((a) => a.alias === 'production');
  const versions = `${tool.versionCount} version${tool.versionCount === 1 ? '' : 's'}`;
  return production ? `production → v${production.versionNumber} · ${versions}` : versions;
}

/**
 * Parses a tool detail page's "new alias" version `<Select>`'s value into a version
 * number worth committing.
 *
 * The placeholder option carries `value=""`, and `Number('')` is `0` — which
 * `Number.isInteger` accepts, so a blank selection used to parse as a request for
 * version 0. Only the Create button's `disabled` attribute stopped that reaching
 * `POST /tools/:id/aliases/:alias/promote`; this rejects blank and anything below the
 * first real version number (`1`) directly, so the guard holds even if something else
 * ever calls the handler without going through that button.
 *
 * @param value - The raw `<Select>` value: a version number as a string, or `""`.
 * @returns The parsed version number, or `null` when it is not a committable version.
 */
export function parseAliasVersionInput(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}
