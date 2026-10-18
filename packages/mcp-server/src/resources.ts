import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AcruxCoreClient } from './client';
import type { McpServerConfig } from './config';
import { truncateText } from './format';

/** A prompt row from `GET /prompts`. */
interface PromptRow {
  id: string;
  name: string;
  description?: string | null;
}

/**
 * Registers the `acruxcore://` resources.
 *
 * Resources exist alongside the tools because reading and doing are different acts. A
 * client attaches a resource to context without a tool call and without the model
 * deciding to fetch it — which is exactly right for "here is the prompt template we are
 * discussing" or "here is the trace that failed". The same content is reachable through
 * `get_prompt`/`get_trace`, but only as the result of the model choosing to look.
 *
 * @param server - The MCP server to register on.
 * @param client - REST client carrying the caller's API key.
 * @param config - Resolved configuration.
 */
export function registerResources(
  server: McpServer,
  client: AcruxCoreClient,
  config: McpServerConfig,
): void {
  server.registerResource(
    'prompt-template',
    new ResourceTemplate('acruxcore://prompts/{name}/{alias}', {
      // Listing the registry at the configured alias gives the client something to show
      // in a resource picker. Every alias of every prompt would be a combinatorial list
      // nobody can scan.
      list: async () => {
        const listed = await client.get<{ data?: PromptRow[] }>('/prompts', { limit: 100 });
        return {
          resources: (listed.data ?? []).map((row) => ({
            uri: `acruxcore://prompts/${row.name}/${config.promptAlias}`,
            name: row.name,
            description: row.description ?? `AcruxCore prompt "${row.name}".`,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'AcruxCore prompt template',
      description:
        'The raw, unrendered template of the version an alias points at, with its ' +
        'variables and bound default model.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const name = String(variables.name);
      const alias = String(variables.alias);

      // The raw template, not a render: a resource is for reading what the prompt *is*,
      // and rendering would need variable values the reader has not supplied.
      const promptId = await promptIdFor(client, name);
      const aliases = await client.get<Array<{ alias: string; versionNumber: number }>>(
        `/prompts/${promptId}/aliases`,
      );
      const match = aliases.find((a) => a.alias === alias);
      if (!match) {
        throw new Error(`Prompt "${name}" has no alias "${alias}".`);
      }
      const version = await client.get<unknown>(
        `/prompts/${promptId}/versions/${match.versionNumber}`,
      );

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: truncateText(JSON.stringify(version, null, 2), config.maxTextBytes),
          },
        ],
      };
    },
  );

  server.registerResource(
    'trace',
    new ResourceTemplate('acruxcore://traces/{traceId}', {
      // Deliberately unlisted: a team accumulates traces without limit, so enumerating
      // them into a resource picker would be useless at best. Traces are found with
      // search_traces and then addressed by id.
      list: undefined,
    }),
    {
      title: 'AcruxCore trace',
      description: 'One trace with its full span tree, tokens, cost and latency.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const trace = await client.get<unknown>(`/traces/${String(variables.traceId)}`);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: truncateText(JSON.stringify(trace, null, 2), config.maxTextBytes),
          },
        ],
      };
    },
  );
}

/**
 * Looks up a prompt id by name for the resource handlers.
 *
 * @param client - REST client.
 * @param name - Prompt name from the URI.
 * @returns The prompt's UUID.
 * @throws {Error} When no prompt in the team carries that name.
 */
async function promptIdFor(client: AcruxCoreClient, name: string): Promise<string> {
  const listed = await client.get<{ data?: PromptRow[] }>('/prompts', { search: name, limit: 100 });
  const exact = (listed.data ?? []).find((row) => row.name === name);
  if (!exact) throw new Error(`No prompt named "${name}" in this team.`);
  return exact.id;
}
