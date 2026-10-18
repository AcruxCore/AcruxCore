import { z } from 'zod';
import { listSummary, okResult } from '../format';
import { resolveToolRef } from '../refs';
import { defineTool, type AnyToolDefinition } from './types';

/** A tool reference accepted by every tool here. */
const toolRef = z
  .string()
  .min(1)
  .describe('Catalog tool name (e.g. "get_weather") or tool UUID. Names are resolved for you.');

/** One name/value pair used for a header or a query parameter on an HTTP executor. */
const nameValueSchema = z.object({
  name: z.string().min(1).describe('Header or query parameter name.'),
  value: z
    .string()
    .describe('Value. May reference a stored secret as {{ secrets.MY_SECRET }}.'),
});

/** How a tool argument is carried into the upstream HTTP request. */
const argMappingSchema = z.object({
  arg: z.string().min(1).describe('Argument name from parametersSchema.'),
  in: z.enum(['query', 'path', 'header', 'body']).describe('Where the argument goes.'),
  path: z.string().optional().describe('Dotted path within the body, when `in` is "body".'),
});

/** Either "your app runs it" or a declarative HTTP call AcruxCore runs server-side. */
const executorSchema = z.union([
  z
    .object({ type: z.literal('client') })
    .describe('Definition only — the caller\'s own app executes the tool.'),
  z
    .object({
      type: z.literal('http'),
      url: z.string().url().describe('Absolute upstream URL. localhost is rejected by design.'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      headers: z.array(nameValueSchema).optional(),
      query: z.array(nameValueSchema).optional(),
      bodyTemplate: z.string().optional().describe('JSON body template.'),
      argMapping: z.array(argMappingSchema).optional(),
      requestTransform: z
        .string()
        .optional()
        .describe('Full JS function source: function transform(input) { … }'),
      responseTransform: z
        .string()
        .optional()
        .describe('Full JS function source: function transform(input) { … }'),
    })
    .describe('AcruxCore executes the call server-side.'),
]);

/**
 * Tools for the Tool Catalog — the versioned registry of function definitions a prompt
 * can bind to.
 *
 * The distinction these descriptions must carry is the one people get wrong: a catalog
 * entry has a *definition* (the schema and description the model reads) and an
 * *executor* (who actually runs it). A `client` executor stores only the definition; an
 * `http` executor lets AcruxCore make the call itself.
 */
export const catalogTools: AnyToolDefinition[] = [
  defineTool({
    name: 'list_catalog_tools',
    title: 'List catalog tools',
    toolset: 'tools',
    readOnlyHint: true,
    description:
      'List the tools in the team\'s Tool Catalog. These are the function definitions a ' +
      'prompt alias can bind to and the gateway can attach to a completion.',
    inputSchema: {
      search: z.string().optional().describe('Substring filter over name and description.'),
      page: z.number().int().positive().optional().describe('1-based page number.'),
      limit: z.number().int().positive().max(100).optional().describe('Results per page, max 100.'),
    },
    async handler({ search, page, limit }, { client, config }) {
      const result = await client.get<{ data?: unknown[]; total?: number }>('/tools', {
        search,
        page,
        limit,
      });
      return okResult(listSummary('catalog tools', result), result, config.maxTextBytes);
    },
  }),

  defineTool({
    name: 'get_catalog_tool',
    title: 'Get a catalog tool with its versions and aliases',
    toolset: 'tools',
    readOnlyHint: true,
    description:
      'Read one catalog tool in full: metadata, every committed version (parameters ' +
      'schema, executor, source) and every alias with the version it points at. Call ' +
      'this before executing, to see whether the tool has a server-side http executor ' +
      'or is definition-only.',
    inputSchema: { tool: toolRef },
    async handler({ tool }, { client, config }) {
      const id = await resolveToolRef(client, tool);
      const [detail, versions, aliases] = await Promise.all([
        client.get<Record<string, unknown>>(`/tools/${id}`),
        client.get<{ data?: unknown[] }>(`/tools/${id}/versions`, { limit: 100 }),
        client.get<unknown[]>(`/tools/${id}/aliases`),
      ]);
      return okResult(
        `Tool "${detail.name}" — ${versions.data?.length ?? 0} version(s).`,
        { tool: detail, versions: versions.data ?? [], aliases },
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'sync_catalog_tool',
    title: 'Create or update a catalog tool',
    toolset: 'tools',
    readOnlyHint: false,
    description:
      'Create-or-commit-or-nothing for one tool, addressed by name. If the name is new ' +
      'the tool is created and v1 committed; if the spec differs from the version the ' +
      'alias points at, a new version is committed and the alias moved; if the spec is ' +
      'identical, nothing happens (key order does not count as a change). This is the ' +
      'one call to use for "add this tool" and "update this tool\'s description" alike.',
    inputSchema: {
      name: z
        .string()
        .min(1)
        .max(64)
        .describe('Tool name. Must match ^[a-zA-Z0-9_-]{1,64}$ — LLM function-name safe.'),
      description: z
        .string()
        .max(2000)
        .optional()
        .describe('What the tool does. This is text the MODEL reads, so write it for a model.'),
      parametersSchema: z
        .record(z.unknown())
        .describe('JSON Schema object for the arguments, e.g. {"type":"object","properties":{…}}.'),
      executor: executorSchema,
      alias: z.string().min(1).max(64).optional().describe('Alias to move. Default "production".'),
      changelog: z.string().max(2000).optional().describe('Why this version changed.'),
    },
    async handler(args, { client, config }) {
      const result = await client.post<{
        toolId: string;
        versionNumber: number;
        committed: boolean;
        alias: string;
      }>('/tools/sync', {
        ...args,
        // `code` means "derived from a decorated function in a source file", and the
        // dashboard's ownership warnings depend on that being literally true. An MCP
        // client is not that, so it claims `api` rather than taking the endpoint default.
        source: 'api',
      });
      return okResult(
        result.committed
          ? `Committed version ${result.versionNumber} of "${args.name}"; alias "${result.alias}" now points at it.`
          : `No change — "${args.name}" already matches version ${result.versionNumber} at alias "${result.alias}".`,
        result,
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'execute_catalog_tool',
    title: 'Execute a catalog tool',
    toolset: 'tools',
    readOnlyHint: false,
    description:
      'Run a catalog tool server-side and return its result. Only works for a version ' +
      'with an "http" executor — a definition-only ("client") version returns ' +
      'NOT_EXECUTABLE, because there is nothing for AcruxCore to call. Arguments are ' +
      'validated against the version\'s parameters schema before the call is made.',
    inputSchema: {
      tool: toolRef,
      arguments: z.record(z.unknown()).describe('Arguments matching the tool\'s parameters schema.'),
      alias: z.string().optional().describe('Alias to resolve. Default "production".'),
      version_number: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Pin an exact version instead of following an alias.'),
    },
    async handler({ tool, ...args }, { client, config }) {
      const id = await resolveToolRef(client, tool);
      const body: Record<string, unknown> = { arguments: args.arguments };
      if (args.alias !== undefined) body.alias = args.alias;
      if (args.version_number !== undefined) body.versionNumber = args.version_number;

      const result = await client.post<{ status?: number; latencyMs?: number }>(
        `/tools/${id}/execute`,
        body,
      );
      return okResult(
        `Executed "${tool}" — upstream status ${result.status}, ${result.latencyMs}ms.`,
        result,
        config.maxTextBytes,
      );
    },
  }),
];
