import { describe, expect, it } from 'vitest';
import {
  ALL_TOOLSETS,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_TEXT_BYTES,
  DEFAULT_PROMPT_ALIAS,
  parseToolsets,
  resolveConfig,
} from '../../src/config';
import { McpConfigError } from '../../src/errors';

describe('resolveConfig', () => {
  it('defaults everything except the API key', () => {
    const config = resolveConfig({ env: { ACRUXCORE_API_KEY: 'acx_sk_test' }, argv: [] });

    expect(config).toEqual({
      apiKey: 'acx_sk_test',
      baseUrl: DEFAULT_BASE_URL,
      toolsets: [...ALL_TOOLSETS],
      readOnly: false,
      promptAlias: DEFAULT_PROMPT_ALIAS,
      maxTextBytes: DEFAULT_MAX_TEXT_BYTES,
      timeoutMs: 60_000,
    });
  });

  it('refuses to start without an API key, and says where to get one', () => {
    expect(() => resolveConfig({ env: {}, argv: [] })).toThrow(McpConfigError);
    expect(() => resolveConfig({ env: {}, argv: [] })).toThrow(/ACRUXCORE_API_KEY/);
  });

  it('treats a whitespace-only API key as absent', () => {
    expect(() => resolveConfig({ env: { ACRUXCORE_API_KEY: '   ' }, argv: [] })).toThrow(
      McpConfigError,
    );
  });

  it('lets a CLI flag beat the environment', () => {
    const config = resolveConfig({
      env: { ACRUXCORE_API_KEY: 'from-env', ACRUXCORE_BASE_URL: 'https://env.example.com/api/v1' },
      argv: ['--api-key', 'from-flag', '--base-url=https://flag.example.com/api/v1'],
    });

    expect(config.apiKey).toBe('from-flag');
    expect(config.baseUrl).toBe('https://flag.example.com/api/v1');
  });

  it('reads --read-only as a bare flag and from the environment', () => {
    const flagged = resolveConfig({
      env: { ACRUXCORE_API_KEY: 'k' },
      argv: ['--read-only'],
    });
    const fromEnv = resolveConfig({
      env: { ACRUXCORE_API_KEY: 'k', ACRUXCORE_MCP_READ_ONLY: 'yes' },
      argv: [],
    });
    const off = resolveConfig({
      env: { ACRUXCORE_API_KEY: 'k', ACRUXCORE_MCP_READ_ONLY: 'no' },
      argv: [],
    });

    expect(flagged.readOnly).toBe(true);
    expect(fromEnv.readOnly).toBe(true);
    expect(off.readOnly).toBe(false);
  });

  it('rejects a non-numeric size limit rather than silently falling back', () => {
    expect(() =>
      resolveConfig({ env: { ACRUXCORE_API_KEY: 'k' }, argv: ['--max-text-bytes', 'lots'] }),
    ).toThrow(/positive integer/);
  });

  it('falls back to the default prompt alias when the value is blank', () => {
    const config = resolveConfig({
      env: { ACRUXCORE_API_KEY: 'k', ACRUXCORE_MCP_PROMPT_ALIAS: '  ' },
      argv: [],
    });
    expect(config.promptAlias).toBe(DEFAULT_PROMPT_ALIAS);
  });
});

describe('parseToolsets', () => {
  it('treats empty and "all" as every toolset', () => {
    expect(parseToolsets('')).toEqual([...ALL_TOOLSETS]);
    expect(parseToolsets('all')).toEqual([...ALL_TOOLSETS]);
  });

  it('returns the requested toolsets in canonical order, not request order', () => {
    expect(parseToolsets('traces,prompts')).toEqual(['prompts', 'traces']);
  });

  it('ignores case, whitespace and duplicates', () => {
    expect(parseToolsets(' Prompts , prompts,  TRACES ')).toEqual(['prompts', 'traces']);
  });

  it('names the unknown toolset and lists the valid ones', () => {
    expect(() => parseToolsets('prompts,wombat')).toThrow(/wombat/);
    expect(() => parseToolsets('prompts,wombat')).toThrow(/evaluations/);
  });
});
