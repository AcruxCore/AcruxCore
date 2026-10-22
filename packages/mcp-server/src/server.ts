import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AcruxCoreClient } from './client';
import type { McpServerConfig } from './config';
import { errorResult } from './format';
import { registerRegistryPrompts } from './registry-prompts';
import { registerResources } from './resources';
import { selectTools } from './toolsets';

/** Version reported to clients in `initialize`. Kept in step with package.json. */
export const SERVER_VERSION = '0.2.0';

/** What the caller gets back, so a host can inspect what was registered. */
export interface BuiltServer {
  /** The configured MCP server, not yet connected to a transport. */
  server: McpServer;
  /** REST client the tools use. */
  client: AcruxCoreClient;
  /** Names of the tools that were registered, in listing order. */
  toolNames: string[];
}

/**
 * Builds the `instructions` string sent to clients on `initialize`.
 *
 * Worth writing carefully: it is the only place to explain the registry's *model* —
 * prompt, version, alias — and a client that misunderstands that will commit versions
 * and then wonder why nothing changed in production.
 *
 * It is built from the tools actually registered, because the model reads it as a list
 * of things it can do: naming `promote_prompt_alias` to a read-only client sends it
 * looking for a tool that is not there.
 *
 * @param toolNames - Names of the tools this server registered.
 * @param readOnly - Whether mutating tools were removed from the listing.
 * @returns The instructions text.
 */
function buildInstructions(toolNames: ReadonlySet<string>, readOnly: boolean): string {
  const parts = [
    `AcruxCore is an LLM-ops platform: a prompt registry, a versioned tool catalog, an AI gateway, tracing, and evaluation.

Three ideas explain almost every tool here:
- A **prompt** is a named container. It holds no messages itself.
- A **version** is an immutable commit of that prompt's messages. Version numbers are sequential.
- An **alias** ("production", "staging", anything else) is a moving pointer at one version.`,
  ];

  if (toolNames.has('promote_prompt_alias')) {
    parts.push(
      'Committing a version never moves an alias — promote_prompt_alias is what ships a change, and promoting an earlier version is how a rollback happens.',
    );
  }
  if (readOnly) {
    parts.push(
      'This connection is read-only: it can list, read, render and diff, but it cannot create, commit, promote, run or change anything.',
    );
  }
  parts.push(
    'Registry prompts are also exposed through MCP\'s prompts primitive, so they can be used directly as templates. Tools that take a prompt or a catalog tool accept a name or a UUID.',
  );
  return parts.join('\n\n');
}

/**
 * Builds a fully configured AcruxCore MCP server.
 *
 * Transport-agnostic on purpose: the stdio binary and the API's hosted HTTP endpoint
 * both call this and then connect whatever transport they own. Adding a tool once makes
 * it appear on both.
 *
 * @param config - Resolved configuration, including the API key every call will carry.
 * @returns The server, its REST client, and the registered tool names.
 */
export function createAcruxCoreMcpServer(config: McpServerConfig): BuiltServer {
  const client = new AcruxCoreClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    userAgent: `acruxcore-mcp-server/${SERVER_VERSION}`,
  });

  const tools = selectTools(config);
  const server = new McpServer(
    { name: 'acruxcore', title: 'AcruxCore', version: SERVER_VERSION },
    {
      instructions: buildInstructions(
        new Set(tools.map((tool) => tool.name)),
        config.readOnly,
      ),
    },
  );

  for (const tool of tools) {
    // A tool with no arguments registers no input schema at all. The SDK validates a
    // declared schema with `z.object(shape).parse(params.arguments)`, and `arguments` is
    // optional in the protocol — so declaring an empty schema would make
    // `{"name":"list_models"}`, a perfectly legal call, fail validation. With no schema
    // the SDK skips validation entirely and the call goes through.
    const inputSchema =
      Object.keys(tool.inputSchema).length > 0 ? tool.inputSchema : undefined;

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnlyHint,
          destructiveHint: tool.destructiveHint ?? false,
        },
      },
      async (args: unknown) => {
        try {
          return await tool.handler(args, { client, config });
        } catch (error) {
          // Every failure is reported in-band rather than thrown. A thrown error becomes
          // a JSON-RPC error the model never sees, so it retries the identical call;
          // an isError result puts the API's own code and message in front of it.
          return errorResult(error, config.maxTextBytes);
        }
      },
    );
  }

  registerRegistryPrompts(server, client, config);
  registerResources(server, client, config);

  return { server, client, toolNames: tools.map((tool) => tool.name) };
}
