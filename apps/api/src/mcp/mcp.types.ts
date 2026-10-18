import {
  ALL_TOOLSETS,
  DEFAULT_MAX_TEXT_BYTES,
  DEFAULT_PROMPT_ALIAS,
  type McpServerConfig,
} from '@acruxcoreai/mcp-server';

/**
 * The hosted endpoint's own view of where the API lives, so the MCP tools can reach the
 * rest of the API over loopback.
 *
 * Set once by `server.ts` from the address the HTTP server actually bound to, rather
 * than reconstructed from `PORT`. Reconstruction is where this goes wrong: the port that
 * ends up in the environment and the port the process listens on are the same value
 * right up until a deployment sets one and not the other, and the failure then looks
 * like "every MCP tool call times out" rather than "the URL is wrong".
 */
let selfBaseUrl: string | undefined;

/**
 * Records the base URL the API is serving on.
 *
 * @param url - Absolute base URL including the `/api/v1` prefix.
 */
export function setSelfBaseUrl(url: string): void {
  selfBaseUrl = url;
}

/**
 * Returns the base URL the MCP tools should call.
 *
 * Falls back to `MCP_SELF_BASE_URL`, then to the same PORT/API_PORT chain `server.ts`
 * uses — that path is what a test importing `createApp()` directly gets, since nothing
 * called {@link setSelfBaseUrl}.
 *
 * @returns Base URL ending in `/api/v1`.
 */
export function getSelfBaseUrl(): string {
  if (selfBaseUrl) return selfBaseUrl;
  if (process.env.MCP_SELF_BASE_URL) return process.env.MCP_SELF_BASE_URL;
  const port = process.env.PORT ?? process.env.API_PORT ?? '3000';
  return `http://127.0.0.1:${port}/api/v1`;
}

/**
 * Builds the MCP server configuration for one hosted request.
 *
 * Every value except the API key is fixed for the hosted transport: toolsets and
 * read-only mode are per-client choices that a remote client has no way to express in
 * the protocol, so the hosted endpoint exposes the full surface and leaves narrowing to
 * the stdio package, where flags exist.
 *
 * @param apiKey - The caller's bearer token, reused verbatim for the loopback calls.
 * @returns A full configuration.
 */
export function hostedConfig(apiKey: string): McpServerConfig {
  return {
    baseUrl: getSelfBaseUrl(),
    apiKey,
    // Spread `ALL_TOOLSETS` rather than listing the five by hand: a sixth toolset added
    // to the package would otherwise appear over stdio and be silently missing here.
    toolsets: [...ALL_TOOLSETS],
    readOnly: false,
    promptAlias: process.env.MCP_PROMPT_ALIAS ?? DEFAULT_PROMPT_ALIAS,
    maxTextBytes: DEFAULT_MAX_TEXT_BYTES,
    timeoutMs: 60_000,
  };
}
