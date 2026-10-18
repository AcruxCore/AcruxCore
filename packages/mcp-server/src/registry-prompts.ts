import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  type GetPromptResult,
  type ListPromptsResult,
  type PromptMessage,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AcruxCoreClient } from './client';
import type { McpServerConfig } from './config';

/** How many registry prompts one `prompts/list` page carries. */
const PAGE_SIZE = 25;

/** How many per-prompt lookups run at once while building a page. */
const LOOKUP_CONCURRENCY = 8;

/** A prompt row from `GET /prompts`. */
interface PromptRow {
  id: string;
  name: string;
  description?: string | null;
}

/** An alias row from `GET /prompts/:id/aliases`. */
interface AliasRow {
  alias: string;
  versionNumber: number;
}

/** A version row from `GET /prompts/:id/versions`. */
interface VersionRow {
  versionNumber: number;
  variables?: string[];
}

/** A registry prompt resolved to what MCP needs to advertise it. */
interface ResolvedPrompt {
  name: string;
  description: string;
  variables: string[];
}

/**
 * Runs an async mapper over a list with a fixed concurrency ceiling.
 *
 * Building a prompts page costs two lookups per prompt. Firing them all at once against
 * a 100-prompt registry would open 200 sockets; doing them one at a time would make the
 * listing visibly slow. Eight at a time is the compromise.
 *
 * @param items - Input items.
 * @param limit - Maximum in-flight mappers.
 * @param mapper - Async transform.
 * @returns Results in input order.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Resolves one registry prompt to the alias's version and that version's variables.
 *
 * Returns `null` rather than throwing when the prompt has no version at the configured
 * alias: a half-built prompt is a normal state in a registry, and one of them must not
 * break the whole listing.
 *
 * @param client - REST client.
 * @param row - The prompt row.
 * @param alias - Alias to resolve.
 * @returns The resolved prompt, or null when the alias does not exist for it.
 */
async function resolvePrompt(
  client: AcruxCoreClient,
  row: PromptRow,
  alias: string,
): Promise<ResolvedPrompt | null> {
  try {
    const [aliases, versions] = await Promise.all([
      client.get<AliasRow[]>(`/prompts/${row.id}/aliases`),
      client.get<{ data?: VersionRow[] }>(`/prompts/${row.id}/versions`, { limit: 100 }),
    ]);

    const match = (Array.isArray(aliases) ? aliases : []).find((a) => a.alias === alias);
    if (!match) return null;

    const version = (versions.data ?? []).find((v) => v.versionNumber === match.versionNumber);
    return {
      name: row.name,
      description:
        `${row.description ?? 'AcruxCore registry prompt'} ` +
        `(alias "${alias}", version ${match.versionNumber})`,
      variables: version?.variables ?? [],
    };
  } catch {
    // One unreadable prompt must not empty the whole list — the client would show
    // "no prompts" and the user would think the server was broken.
    return null;
  }
}

/**
 * Builds one page of registry prompts.
 *
 * @param client - REST client.
 * @param alias - Alias to expose.
 * @param page - 1-based page number.
 * @returns The resolved prompts and whether another page exists.
 */
async function listRegistryPrompts(
  client: AcruxCoreClient,
  alias: string,
  page: number,
): Promise<{ prompts: ResolvedPrompt[]; hasMore: boolean }> {
  const listed = await client.get<{ data?: PromptRow[]; total?: number }>('/prompts', {
    page,
    limit: PAGE_SIZE,
  });
  const rows = listed.data ?? [];
  const resolved = await mapWithConcurrency(rows, LOOKUP_CONCURRENCY, (row) =>
    resolvePrompt(client, row, alias),
  );
  const total = listed.total ?? rows.length;
  return {
    prompts: resolved.filter((p): p is ResolvedPrompt => p !== null),
    hasMore: page * PAGE_SIZE < total,
  };
}

/**
 * Converts rendered registry messages into MCP prompt messages.
 *
 * MCP's `PromptMessage.role` is `user | assistant` — the protocol has no system role.
 * A registry prompt whose template opens with a system message therefore cannot
 * round-trip as-is. Emitting it as the leading `user` message keeps the instruction in
 * the conversation, in position, with its text unchanged; dropping it would silently
 * change what the prompt does.
 *
 * @param messages - Rendered messages from the render endpoint.
 * @returns MCP-shaped prompt messages.
 */
export function toPromptMessages(
  messages: Array<{ role?: string; content?: unknown }>,
): PromptMessage[] {
  return messages.map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: {
      type: 'text' as const,
      text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    },
  }));
}

/**
 * Registers the MCP prompts primitive, backed by the AcruxCore prompt registry.
 *
 * This is the piece that makes the server more than an API wrapper: a team's production
 * prompts become slash commands in the client, with the template variables as typed
 * arguments, resolved through the same alias production traffic uses.
 *
 * Handlers are set on the low-level server rather than through `registerPrompt` because
 * the list is not known at startup — it is whatever the team's registry holds right now.
 *
 * Nothing is cached. The obvious 60-second cache would be a module-level map shared by
 * every request of the hosted transport, where each request may carry a *different*
 * team's API key — a cross-tenant leak in exchange for saving one list call.
 *
 * @param server - The MCP server to register on.
 * @param client - REST client carrying the caller's API key.
 * @param config - Resolved configuration; `promptAlias` decides which alias is exposed.
 */
export function registerRegistryPrompts(
  server: McpServer,
  client: AcruxCoreClient,
  config: McpServerConfig,
): void {
  server.server.registerCapabilities({ prompts: { listChanged: false } });

  server.server.setRequestHandler(ListPromptsRequestSchema, async (request): Promise<ListPromptsResult> => {
    const page = parseCursor(request.params?.cursor);
    const { prompts, hasMore } = await listRegistryPrompts(client, config.promptAlias, page);

    return {
      prompts: prompts.map((prompt) => ({
        name: prompt.name,
        title: prompt.name,
        description: prompt.description,
        arguments: prompt.variables.map((variable) => ({
          name: variable,
          description: `Template variable "${variable}".`,
          required: true,
        })),
      })),
      ...(hasMore ? { nextCursor: String(page + 1) } : {}),
    };
  });

  server.server.setRequestHandler(GetPromptRequestSchema, async (request): Promise<GetPromptResult> => {
    const { name, arguments: args } = request.params;
    const rendered = await client.post<{
      messages?: Array<{ role?: string; content?: unknown }>;
      versionNumber?: number;
    }>(`/prompts/${encodeURIComponent(name)}/${encodeURIComponent(config.promptAlias)}/render`, {
      variables: args ?? {},
    });

    return {
      description: `AcruxCore prompt "${name}" at alias "${config.promptAlias}" (version ${rendered.versionNumber}).`,
      messages: toPromptMessages(rendered.messages ?? []),
    };
  });
}

/**
 * Reads a page number out of an MCP cursor.
 *
 * @param cursor - Opaque cursor from the client, if any.
 * @returns A 1-based page number; 1 for anything unparseable.
 */
function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 1;
  const page = Number(cursor);
  return Number.isInteger(page) && page > 0 ? page : 1;
}
