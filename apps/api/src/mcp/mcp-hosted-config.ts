import { McpConfigError, resolveConfig, type McpServerConfig } from '@acruxcoreai/mcp-server';
import { ValidationError } from '../shared/errors';
import { getSelfBaseUrl, type HostedMcpQuery } from './mcp.types';

/**
 * Builds the MCP server configuration for one hosted request.
 *
 * The options go through the local server's own `resolveConfig`, as if they were CLI
 * flags, so the hosted endpoint and the local server accept the same values, apply the
 * same defaults and reject the same mistakes with the same messages. The hosted-only
 * rules (no repeats, caps, strict booleans) are applied earlier, by `HostedMcpQuerySchema`.
 *
 * @param apiKey - The caller's bearer token, reused verbatim for the loopback calls.
 * @param query - Options already validated by `HostedMcpQuerySchema`.
 * @returns A full configuration.
 * @throws {ValidationError} If the local server rejects a value (an unknown toolset, a
 *   non-positive number).
 */
export function hostedConfig(apiKey: string, query: HostedMcpQuery = {}): McpServerConfig {
  const argv = Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `--${name}=${value}`);

  try {
    return resolveConfig({
      env: {
        ACRUXCORE_API_KEY: apiKey,
        ACRUXCORE_BASE_URL: getSelfBaseUrl(),
        ACRUXCORE_MCP_PROMPT_ALIAS: process.env.MCP_PROMPT_ALIAS,
      },
      argv,
    });
  } catch (error) {
    if (error instanceof McpConfigError) throw new ValidationError(error.message);
    throw error;
  }
}
