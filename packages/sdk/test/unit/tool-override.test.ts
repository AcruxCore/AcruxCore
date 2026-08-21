import { describe, it, expect, vi, afterEach } from 'vitest';
import { withToolOverride } from '../../src/tool-override';
import type { ToolDefinition } from '../../src/types';

function toolDef(name: string): ToolDefinition {
  return { type: 'function', function: { name, parameters: { type: 'object', properties: {} } } };
}

describe('withToolOverride', () => {
  afterEach(() => vi.restoreAllMocks());

  it('adds a not-yet-bound tool to toolRefs without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rendered = { tools: [toolDef('get_weather')], toolResolutions: [{ name: 'get_weather', alias: 'production', versionNumber: 3, source: 'default' as const }] };

    const result = withToolOverride(rendered, { name: 'best_run_hour', alias: 'staging' });

    expect(result.tools).toEqual(rendered.tools); // untouched — different tool
    expect(result.toolRefs).toEqual([{ name: 'best_run_hour', alias: 'staging' }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('removes an already-bound tool from tools and warns with its current alias', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rendered = {
      tools: [toolDef('get_weather'), toolDef('best_run_hour')],
      toolResolutions: [
        { name: 'get_weather', alias: 'production', versionNumber: 3, source: 'default' as const },
        { name: 'best_run_hour', alias: 'production', versionNumber: 1, source: 'default' as const },
      ],
    };

    const result = withToolOverride(rendered, { name: 'get_weather', alias: 'staging' });

    expect(result.tools.map((t) => t.function.name)).toEqual(['best_run_hour']);
    expect(result.toolRefs).toEqual([{ name: 'get_weather', alias: 'staging' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain('get_weather');
    expect(message).toContain('staging');
    expect(message).toContain('"production"');
  });

  it("names the prompt's default binding when the default decided the current value", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rendered = {
      tools: [toolDef('get_weather')],
      toolResolutions: [{ name: 'get_weather', alias: 'dev', versionNumber: 3, source: 'default' as const }],
    };

    withToolOverride(rendered, { name: 'get_weather', alias: 'staging' });

    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain("the prompt's default binding");
  });

  it("names the alias's own binding when this prompt alias decided the current value", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rendered = {
      tools: [toolDef('get_weather')],
      toolResolutions: [{ name: 'get_weather', alias: 'dev', versionNumber: 3, source: 'alias' as const }],
    };

    withToolOverride(rendered, { name: 'get_weather', alias: 'staging' });

    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain("this prompt alias's own binding");
  });

  it('mentions the pin, not an alias, when the current binding is pinned', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rendered = {
      tools: [toolDef('get_weather')],
      toolResolutions: [{ name: 'get_weather', pinnedVersionNumber: 2, versionNumber: 2, source: 'default' as const }],
    };

    withToolOverride(rendered, { name: 'get_weather', alias: 'staging' });

    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain('pinned to v2');
  });
});
