import { describe, expect, it } from 'vitest';
import type { ToolSummary } from '@/api';
import { TOOL_NAME_PATTERN, filterTools, parseAliasVersionInput, toolStatus, toolVersionSummary } from './catalog';

/** A callable http tool, the shape a healthy row has. */
function tool(over: Partial<ToolSummary> = {}): ToolSummary {
  return {
    id: 't-1',
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    teamId: 'team-1',
    createdBy: 'u-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    callable: true,
    versionCount: 3,
    latestVersionNumber: 3,
    executorType: 'http',
    aliases: [
      { alias: 'production', versionNumber: 2 },
      { alias: 'staging', versionNumber: 3 },
    ],
    ...over,
  };
}

describe('filterTools', () => {
  it('matches on name and on description', () => {
    const all = [tool(), tool({ id: 't-2', name: 'search_docs', description: 'Find a passage.' })];
    expect(filterTools(all, 'weather').map((t) => t.id)).toEqual(['t-1']);
    expect(filterTools(all, 'passage').map((t) => t.id)).toEqual(['t-2']);
    expect(filterTools(all, '  ')).toHaveLength(2);
  });

  it('ignores case and tolerates a null description', () => {
    const all = [tool({ description: null }), tool({ id: 't-2', name: 'SEARCH_docs' })];
    expect(filterTools(all, 'GET_WEA').map((t) => t.id)).toEqual(['t-1']);
    expect(filterTools(all, 'search')).toHaveLength(1);
  });
});

describe('toolStatus', () => {
  /**
   * The state this whole readiness pass exists for. A tool with no version resolves to
   * nothing, and its row used to be indistinguishable from a working one — so the first
   * sign of trouble was a prompt silently running with one tool fewer.
   */
  it('flags a tool with no versions and says what fixes it', () => {
    const status = toolStatus(tool({ callable: false, versionCount: 0, latestVersionNumber: null, executorType: null, aliases: [] }));
    expect(status.tone).toBe('warn');
    expect(status.label).toBe('No version yet');
    expect(status.hint).toMatch(/Commit a version/);
  });

  /** Versions exist but none is promoted — a different mistake with a different fix. */
  it('distinguishes "has versions but none on production"', () => {
    const status = toolStatus(
      tool({ callable: false, executorType: null, aliases: [{ alias: 'staging', versionNumber: 1 }] }),
    );
    expect(status.tone).toBe('warn');
    expect(status.label).toBe('Not on production');
  });

  it('names where a callable tool runs', () => {
    expect(toolStatus(tool()).label).toBe('Runs on AcruxCore');
    expect(toolStatus(tool({ executorType: 'client' })).label).toBe('Runs in your code');
    expect(toolStatus(tool()).tone).toBe('default');
  });
});

describe('toolVersionSummary', () => {
  it('leads with where production points', () => {
    expect(toolVersionSummary(tool())).toBe('production → v2 · 3 versions');
  });

  it('says nothing for a tool with no versions', () => {
    expect(toolVersionSummary(tool({ versionCount: 0, aliases: [] }))).toBe('');
  });

  it('singularises one version and omits a missing production alias', () => {
    expect(toolVersionSummary(tool({ versionCount: 1, aliases: [] }))).toBe('1 version');
  });
});

describe('TOOL_NAME_PATTERN', () => {
  it('accepts the server-valid characters', () => {
    expect(TOOL_NAME_PATTERN.test('get_weather-2')).toBe(true);
    expect(TOOL_NAME_PATTERN.test('a'.repeat(64))).toBe(true);
  });

  it('rejects what the server would reject', () => {
    expect(TOOL_NAME_PATTERN.test('')).toBe(false);
    expect(TOOL_NAME_PATTERN.test('a'.repeat(65))).toBe(false);
    expect(TOOL_NAME_PATTERN.test('has a space')).toBe(false);
    expect(TOOL_NAME_PATTERN.test('has.dot')).toBe(false);
  });
});

describe('parseAliasVersionInput', () => {
  /**
   * Regression test for finding 4b. A blank `<Select>` value is `""`, and `Number('')`
   * is `0` — which `Number.isInteger` accepted, so the guard this replaces read a blank
   * selection as "commit version 0". Only the Create button's own `disabled` attribute
   * stood between that and a real POST.
   */
  it('rejects a blank selection', () => {
    expect(parseAliasVersionInput('')).toBeNull();
    expect(parseAliasVersionInput('   ')).toBeNull();
  });

  it('rejects zero and anything below the first real version', () => {
    expect(parseAliasVersionInput('0')).toBeNull();
    expect(parseAliasVersionInput('-1')).toBeNull();
  });

  it('rejects a non-numeric or non-integer value', () => {
    expect(parseAliasVersionInput('abc')).toBeNull();
    expect(parseAliasVersionInput('1.5')).toBeNull();
  });

  it('accepts a real version number', () => {
    expect(parseAliasVersionInput('1')).toBe(1);
    expect(parseAliasVersionInput('12')).toBe(12);
  });
});
