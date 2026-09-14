import type { ToolBinding } from '@/api';

/**
 * What one cell of the binding grid currently holds.
 *
 * Five states, because there are genuinely five answers to "what does this prompt do
 * with this tool, in this column" — and collapsing any two of them loses something a
 * reader needs. In particular `off` and `inherit` look the same on screen if you only
 * check whether a row exists, and they mean opposite things: one says "deliberately not
 * here", the other says "whatever the default says".
 */
export type CellState =
  | { kind: 'alias'; toolAlias: string; resolved: number | null }
  | { kind: 'pin'; version: number }
  | { kind: 'off' }
  | { kind: 'inherit' }
  | { kind: 'unbound' };

/**
 * Reads a tool's row in one column, distinguishing "no row" from "row saying off".
 *
 * @param bindings - The rows belonging to this column only.
 * @param toolId - The tool whose cell is being read.
 * @param isDefault - True for the default column, where a missing row means unbound
 *   rather than inherited.
 */
export function cellState(bindings: ToolBinding[], toolId: string, isDefault: boolean): CellState {
  const b = bindings.find((x) => x.toolId === toolId);
  if (!b) return isDefault ? { kind: 'unbound' } : { kind: 'inherit' };
  if (b.off) return { kind: 'off' };
  if (b.pinnedVersionNumber !== null) return { kind: 'pin', version: b.pinnedVersionNumber };
  return { kind: 'alias', toolAlias: b.toolAlias ?? '', resolved: b.resolvedVersionNumber };
}

/** How a cell reads: a short label, and the sentence behind it on hover. */
export interface CellLabel {
  text: string;
  title: string;
  /** True when the cell holds a real binding, so it can be drawn solid rather than dashed. */
  bound: boolean;
}

/**
 * Turns a cell's state into words.
 *
 * The old labels were the implementation's vocabulary — `inherits`, `none`, `pinned v2` —
 * which asked the reader to already know that a prompt alias inherits a default row and
 * that a row with neither an alias nor a pin is a deliberate exclusion. These say what
 * happens instead, and the title says why.
 *
 * @param state - The cell's current state.
 * @returns The label and its hover text.
 */
export function cellLabel(state: CellState): CellLabel {
  switch (state.kind) {
    case 'alias':
      return {
        text: state.resolved !== null ? `${state.toolAlias} → v${state.resolved}` : state.toolAlias,
        title: `Follows the tool's "${state.toolAlias}" alias, so promoting it changes what runs here.`,
        bound: true,
      };
    case 'pin':
      return {
        text: `pinned to v${state.version}`,
        title: `Always runs v${state.version}, whatever the tool's aliases move to.`,
        bound: true,
      };
    case 'off':
      return {
        text: 'not used here',
        title: 'The default connects this tool, and this alias deliberately does not use it.',
        bound: false,
      };
    case 'inherit':
      return {
        text: 'same as default',
        title: 'This alias has no value of its own, so it follows the default column.',
        bound: false,
      };
    case 'unbound':
      return { text: 'not connected', title: 'This prompt does not call this tool.', bound: false };
  }
}
