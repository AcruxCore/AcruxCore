#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveConfig } from './config';
import { McpConfigError } from './errors';
import { createAcruxCoreMcpServer } from './server';

/**
 * Entry point for `npx @acruxcoreai/mcp-server` over stdio.
 *
 * Nothing may be written to stdout here except protocol frames — stdout *is* the
 * transport, and a stray `console.log` corrupts the JSON-RPC stream in a way that looks
 * to the client like a malformed server. Diagnostics go to stderr, which MCP clients
 * capture into their own logs.
 */
async function main(): Promise<void> {
  const config = resolveConfig({ env: process.env, argv: process.argv.slice(2) });
  const { server, toolNames } = createAcruxCoreMcpServer(config);

  console.error(
    `[acruxcore-mcp] ${toolNames.length} tool(s) from toolsets [${config.toolsets.join(', ')}]` +
      `${config.readOnly ? ' (read-only)' : ''} against ${config.baseUrl}`,
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  if (error instanceof McpConfigError) {
    // A configuration mistake is the user's to fix, so print the message alone rather
    // than a stack trace they would have to read past to find it.
    console.error(`[acruxcore-mcp] ${error.message}`);
  } else {
    console.error('[acruxcore-mcp] fatal:', error);
  }
  process.exit(1);
});
