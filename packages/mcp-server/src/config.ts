import { McpConfigError } from './errors';

/** Every toolset this server can expose. */
export const ALL_TOOLSETS = ['prompts', 'gateway', 'tools', 'traces', 'evaluations'] as const;

/** One of the five toolset names. */
export type Toolset = (typeof ALL_TOOLSETS)[number];

/** The AcruxCore cloud API. Overridden with `ACRUXCORE_BASE_URL` when self-hosting. */
export const DEFAULT_BASE_URL = 'https://api.acruxcore.com/api/v1';

/** Alias the prompts primitive exposes when none is configured. */
export const DEFAULT_PROMPT_ALIAS = 'production';

/**
 * Cap on the bytes of text any single tool result may contain.
 *
 * 40 000 is roughly 10k tokens — large enough for a page of traces or a full prompt
 * version, small enough that one careless `get_trace` on a payload-heavy trace cannot
 * eat a client's whole context window.
 */
export const DEFAULT_MAX_TEXT_BYTES = 40_000;

/** Fully resolved server configuration. */
export interface McpServerConfig {
  /** AcruxCore base URL, normalised to end in `/api/v1`. */
  baseUrl: string;
  /** `acx_sk_…` API key used for every call. */
  apiKey: string;
  /** Toolsets to register, in `ALL_TOOLSETS` order. */
  toolsets: Toolset[];
  /** When true, mutating tools are never registered at all. */
  readOnly: boolean;
  /** Alias the MCP prompts primitive resolves registry prompts through. */
  promptAlias: string;
  /** Per-result text cap, in bytes. */
  maxTextBytes: number;
  /** Per-request HTTP timeout, in milliseconds. */
  timeoutMs: number;
}

/** Raw inputs to {@link resolveConfig}, so it can be unit-tested without touching `process`. */
export interface ConfigSources {
  env: Record<string, string | undefined>;
  argv: string[];
}

/**
 * Resolves the server configuration from environment variables, then CLI flags.
 *
 * CLI wins over env on purpose: the env is usually the MCP client's global config, and a
 * flag is what the user typed for *this* server entry.
 *
 * Recognised flags: `--base-url`, `--api-key`, `--toolsets`, `--read-only`,
 * `--prompt-alias`, `--max-text-bytes`, `--timeout-ms`.
 *
 * @param sources - Environment and argv (argv without the node/script prefix).
 * @returns The resolved configuration.
 * @throws {McpConfigError} If the API key is absent, a toolset name is unknown, or a
 *   numeric flag is not a positive number.
 */
export function resolveConfig(sources: ConfigSources): McpServerConfig {
  const { env } = sources;
  const flags = parseFlags(sources.argv);

  const apiKey = (flags['api-key'] ?? env.ACRUXCORE_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new McpConfigError(
      'No AcruxCore API key. Set ACRUXCORE_API_KEY (or pass --api-key). ' +
        'Create one in the dashboard under Settings → API keys.',
    );
  }

  const baseUrl = (flags['base-url'] ?? env.ACRUXCORE_BASE_URL ?? DEFAULT_BASE_URL).trim();

  const toolsetsRaw = (flags.toolsets ?? env.ACRUXCORE_MCP_TOOLSETS ?? '').trim();
  const toolsets = parseToolsets(toolsetsRaw);

  const readOnly = parseBoolean(flags['read-only'] ?? env.ACRUXCORE_MCP_READ_ONLY);

  const promptAlias =
    (flags['prompt-alias'] ?? env.ACRUXCORE_MCP_PROMPT_ALIAS ?? DEFAULT_PROMPT_ALIAS).trim() ||
    DEFAULT_PROMPT_ALIAS;

  const maxTextBytes = parsePositiveInt(
    flags['max-text-bytes'] ?? env.ACRUXCORE_MCP_MAX_TEXT_BYTES,
    DEFAULT_MAX_TEXT_BYTES,
    'max-text-bytes',
  );

  const timeoutMs = parsePositiveInt(
    flags['timeout-ms'] ?? env.ACRUXCORE_MCP_TIMEOUT_MS,
    60_000,
    'timeout-ms',
  );

  return { baseUrl, apiKey, toolsets, readOnly, promptAlias, maxTextBytes, timeoutMs };
}

/**
 * Parses `--flag value` and `--flag=value` pairs out of argv.
 *
 * A flag with no value (`--read-only`) maps to `"true"`, which is what
 * {@link parseBoolean} expects, so boolean flags need no special case at the call site.
 *
 * @param argv - Arguments after the script name.
 * @returns Flag name (without `--`) to string value.
 */
function parseFlags(argv: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;

    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }

    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[name] = next;
      i++;
    } else {
      out[name] = 'true';
    }
  }
  return out;
}

/**
 * Turns a comma-separated toolset list into a validated, de-duplicated array.
 *
 * An empty value means "all of them" — the useful default for someone who has just
 * installed the server and does not yet know what the toolsets are.
 *
 * @param raw - Comma-separated names, `all`, or empty.
 * @returns Toolsets in `ALL_TOOLSETS` order.
 * @throws {McpConfigError} If any name is not a known toolset.
 */
export function parseToolsets(raw: string): Toolset[] {
  if (!raw || raw.toLowerCase() === 'all') return [...ALL_TOOLSETS];

  const requested = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const unknown = requested.filter((name) => !ALL_TOOLSETS.includes(name as Toolset));
  if (unknown.length > 0) {
    throw new McpConfigError(
      `Unknown toolset(s): ${unknown.join(', ')}. Valid toolsets: ${ALL_TOOLSETS.join(', ')}.`,
    );
  }

  // Returned in ALL_TOOLSETS order rather than request order so `tools/list` is stable
  // no matter how the user happened to type the flag.
  return ALL_TOOLSETS.filter((name) => requested.includes(name));
}

/**
 * Reads a boolean from a flag or env value.
 *
 * @param value - Raw string, possibly undefined.
 * @returns True for `true`, `1`, `yes` and `on` (case-insensitive); false otherwise.
 */
function parseBoolean(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Reads a positive integer, falling back to a default when unset.
 *
 * @param value - Raw string, possibly undefined.
 * @param fallback - Value to use when unset or empty.
 * @param name - Flag name, used in the error message.
 * @returns The parsed integer.
 * @throws {McpConfigError} If the value is present but not a positive integer.
 */
function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new McpConfigError(`--${name} must be a positive integer, got "${value}".`);
  }
  return parsed;
}
