import { describe, expect, it } from 'vitest';
import { ALL_TOOLSETS, type McpServerConfig } from '../../src/config';
import { ALL_TOOLS, selectTools } from '../../src/toolsets';

/** A full config with everything on, so each test varies only what it is about. */
function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    baseUrl: 'http://localhost:3000/api/v1',
    apiKey: 'acx_sk_test',
    toolsets: [...ALL_TOOLSETS],
    readOnly: false,
    promptAlias: 'production',
    maxTextBytes: 40_000,
    timeoutMs: 60_000,
    ...overrides,
  };
}

describe('the tool catalogue itself', () => {
  it('has unique names', () => {
    const names = ALL_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every tool a toolset that exists', () => {
    for (const tool of ALL_TOOLS) {
      expect(ALL_TOOLSETS).toContain(tool.toolset);
    }
  });

  it('gives every tool a description long enough to choose it by', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(60);
    }
  });

  it('covers every toolset', () => {
    for (const toolset of ALL_TOOLSETS) {
      expect(ALL_TOOLS.some((tool) => tool.toolset === toolset), toolset).toBe(true);
    }
  });
});

describe('selectTools', () => {
  it('registers everything by default', () => {
    expect(selectTools(config())).toHaveLength(ALL_TOOLS.length);
  });

  it('keeps only the requested toolsets', () => {
    const selected = selectTools(config({ toolsets: ['prompts'] }));

    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every((tool) => tool.toolset === 'prompts')).toBe(true);
  });

  it('removes mutating tools in read-only mode rather than refusing them at call time', () => {
    const selected = selectTools(config({ readOnly: true }));
    const names = selected.map((tool) => tool.name);

    expect(selected.every((tool) => tool.readOnlyHint)).toBe(true);
    expect(names).toContain('list_prompts');
    expect(names).not.toContain('promote_prompt_alias');
    expect(names).not.toContain('commit_prompt_version');
    expect(names).not.toContain('run_prompt');
  });

  it('applies the toolset filter and read-only together', () => {
    const selected = selectTools(config({ toolsets: ['traces'], readOnly: true }));

    expect(selected.map((tool) => tool.name)).not.toContain('submit_trace_feedback');
    expect(selected.map((tool) => tool.name)).toContain('search_traces');
  });
});
