import { describe, expect, it } from 'vitest';
import type { ToolBinding } from '@/api';
import { cellLabel, cellState } from './binding-cell';

function binding(over: Partial<ToolBinding> = {}): ToolBinding {
  return {
    toolId: 't-1',
    toolName: 'get_weather',
    toolAlias: 'production',
    pinnedVersionNumber: null,
    off: false,
    resolvedVersionNumber: 2,
    position: 0,
    ...over,
  };
}

describe('cellState', () => {
  it('reads an alias-following row', () => {
    expect(cellState([binding()], 't-1', true)).toEqual({
      kind: 'alias',
      toolAlias: 'production',
      resolved: 2,
    });
  });

  it('reads a pinned row', () => {
    expect(cellState([binding({ toolAlias: null, pinnedVersionNumber: 3 })], 't-1', true)).toEqual({
      kind: 'pin',
      version: 3,
    });
  });

  /**
   * The distinction the grid exists to show. An alias column with no row inherits the
   * default; an alias column with an "off" row deliberately does not have the tool. Both
   * end up sending nothing, and confusing them means an author cannot tell a decision
   * from an omission.
   */
  it('tells an absent row apart from a row that says off', () => {
    expect(cellState([], 't-1', false)).toEqual({ kind: 'inherit' });
    expect(cellState([binding({ toolAlias: null, off: true })], 't-1', false)).toEqual({ kind: 'off' });
  });

  it('reads an absent row in the default column as unbound, not inherited', () => {
    expect(cellState([], 't-1', true)).toEqual({ kind: 'unbound' });
  });
});

describe('cellLabel', () => {
  it('says which alias is followed and what it resolves to today', () => {
    const label = cellLabel({ kind: 'alias', toolAlias: 'production', resolved: 2 });
    expect(label.text).toBe('production → v2');
    expect(label.title).toMatch(/promoting it changes what runs here/);
    expect(label.bound).toBe(true);
  });

  it('names a pin as fixed, not as an alias', () => {
    expect(cellLabel({ kind: 'pin', version: 3 }).text).toBe('pinned to v3');
  });

  /** Every state reads as a sentence about behaviour, never as the table's own jargon. */
  it('gives the three empty states distinct plain-language labels', () => {
    expect(cellLabel({ kind: 'off' }).text).toBe('not used here');
    expect(cellLabel({ kind: 'inherit' }).text).toBe('same as default');
    expect(cellLabel({ kind: 'unbound' }).text).toBe('not connected');
    expect(cellLabel({ kind: 'off' }).bound).toBe(false);
  });

  it('falls back to the alias name when nothing has resolved yet', () => {
    expect(cellLabel({ kind: 'alias', toolAlias: 'canary', resolved: null }).text).toBe('canary');
  });
});
