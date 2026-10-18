import { z } from 'zod';
import { listSummary, okResult } from '../format';
import { resolvePromptIdAndName, resolvePromptRef } from '../refs';
import { defineTool, type AnyToolDefinition } from './types';

/** A chat message as stored in a prompt version's template. */
const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']).describe('Message role.'),
  content: z.string().describe('Template text. Jinja2/nunjucks syntax: {{ variable }}.'),
});

/** A prompt reference accepted by every tool here. */
const promptRef = z
  .string()
  .min(1)
  .describe('Prompt name (e.g. "customer-support") or prompt UUID. Names are resolved for you.');

/**
 * Tools for the prompt registry: browse, read, render, and move versions between aliases.
 *
 * The mental model these descriptions have to convey, because a model that misses it
 * calls the wrong tool: a **prompt** is a named container, a **version** is an immutable
 * commit of its messages, and an **alias** (`production`, `staging`, anything else) is a
 * moving pointer at one version. Committing never moves an alias; promoting is what
 * ships a change.
 */
export const promptTools: AnyToolDefinition[] = [
  defineTool({
    name: 'list_prompts',
    title: 'List prompts',
    toolset: 'prompts',
    readOnlyHint: true,
    description:
      'List the prompts in the AcruxCore team, newest first. Use `search` to filter by ' +
      'name or description substring. Returns the prompt id, name and description — ' +
      'call get_prompt for versions and aliases.',
    inputSchema: {
      search: z.string().optional().describe('Substring filter over name and description.'),
      page: z.number().int().positive().optional().describe('1-based page number. Default 1.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe('Results per page, max 100. Default 20.'),
    },
    async handler({ search, page, limit }, { client, config }) {
      const result = await client.get<{ data?: unknown[]; total?: number }>('/prompts', {
        search,
        page,
        limit,
      });
      return okResult(listSummary('prompts', result), result, config.maxTextBytes);
    },
  }),

  defineTool({
    name: 'get_prompt',
    title: 'Get a prompt with its versions and aliases',
    toolset: 'prompts',
    readOnlyHint: true,
    description:
      'Read one prompt in full: its metadata, every committed version (number, template ' +
      'variables, bound default model) and every alias with the version it points at. ' +
      'This is the tool to call before committing or promoting, because it shows which ' +
      'version each alias is currently serving.',
    inputSchema: {
      prompt: promptRef,
      include_messages: z
        .boolean()
        .optional()
        .describe(
          'Also fetch the full message template of the newest version. Off by default ' +
            'because templates can be long.',
        ),
    },
    async handler({ prompt, include_messages }, { client, config }) {
      const id = await resolvePromptRef(client, prompt);

      // Three calls, one tool: "show me this prompt" is a single intention, and making
      // the model chain /prompts, /versions and /aliases itself is three chances to stop
      // after the first one and answer from incomplete data.
      const [detail, versions, aliases] = await Promise.all([
        client.get<Record<string, unknown>>(`/prompts/${id}`),
        client.get<{ data?: Array<{ versionNumber: number }> }>(`/prompts/${id}/versions`, {
          limit: 100,
        }),
        client.get<unknown[]>(`/prompts/${id}/aliases`),
      ]);

      let latestVersion: unknown = undefined;
      const newest = versions.data?.[0]?.versionNumber;
      if (include_messages && newest !== undefined) {
        latestVersion = await client.get(`/prompts/${id}/versions/${newest}`);
      }

      const aliasSummary = Array.isArray(aliases)
        ? aliases
            .map((a) => {
              const row = a as { alias?: string; versionNumber?: number };
              return `${row.alias}→v${row.versionNumber}`;
            })
            .join(', ')
        : '';

      return okResult(
        `Prompt "${detail.name}" — ${versions.data?.length ?? 0} version(s); aliases: ${
          aliasSummary || 'none'
        }.`,
        { prompt: detail, versions: versions.data ?? [], aliases, latestVersion },
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'render_prompt',
    title: 'Render a prompt at an alias',
    toolset: 'prompts',
    readOnlyHint: true,
    description:
      'Render the version an alias currently points at, substituting template variables, ' +
      'and return the finished messages plus the tool definitions bound to that alias. ' +
      'This renders only — it calls no model. Use run_prompt to render and get a ' +
      'completion in one step. Missing required variables come back as a ' +
      'MISSING_VARIABLES error naming each one.',
    inputSchema: {
      prompt: promptRef,
      alias: z
        .string()
        .optional()
        .describe('Alias to resolve. Default "production".'),
      variables: z
        .record(z.unknown())
        .optional()
        .describe('Template variables, e.g. {"name":"Alice"}. Required ones come from the version.'),
    },
    async handler({ prompt, alias, variables }, { client, config }) {
      const { name } = await resolvePromptIdAndName(client, prompt);
      const resolvedAlias = alias ?? 'production';
      const rendered = await client.post<{
        messages?: unknown[];
        tools?: unknown[];
        versionNumber?: number;
      }>(`/prompts/${encodeURIComponent(name)}/${encodeURIComponent(resolvedAlias)}/render`, {
        variables: variables ?? {},
      });
      return okResult(
        `Rendered "${name}" at alias "${resolvedAlias}" (version ${rendered.versionNumber}): ` +
          `${rendered.messages?.length ?? 0} message(s), ${rendered.tools?.length ?? 0} bound tool(s).`,
        rendered,
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'diff_prompt_versions',
    title: 'Diff two prompt versions',
    toolset: 'prompts',
    readOnlyHint: true,
    description:
      'Return a unified diff between two committed versions of a prompt. The diff is ' +
      'over the raw templates, not rendered output, so variable placeholders stay visible.',
    inputSchema: {
      prompt: promptRef,
      from_version: z.number().int().positive().describe('Version number to diff from.'),
      to_version: z.number().int().positive().describe('Version number to diff to.'),
    },
    async handler({ prompt, from_version, to_version }, { client, config }) {
      const id = await resolvePromptRef(client, prompt);
      const result = await client.get<{ diff?: string }>(`/prompts/${id}/versions/diff`, {
        from: from_version,
        to: to_version,
      });
      // A unified diff with no `@@` hunk means the message text is the same — the usual
      // cause is a commit that changed only the bound model. Say so, or an empty body
      // reads as a failed call.
      const identical = !(result.diff ?? '').includes('@@');
      return okResult(
        identical
          ? `The messages of v${from_version} and v${to_version} are identical. ` +
              'The diff covers message text only; compare the bound models and settings ' +
              'with get_prompt.'
          : `Diff of v${from_version} → v${to_version}.`,
        result,
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'create_prompt',
    title: 'Create a prompt',
    toolset: 'prompts',
    readOnlyHint: false,
    description:
      'Create an empty prompt container. It has no messages yet — the messages live in ' +
      'versions, so follow this with commit_prompt_version. Fails with TOOL_NAME_TAKEN ' +
      'style 409 semantics if the name is already used in the team.',
    inputSchema: {
      name: z
        .string()
        .min(1)
        .describe('Prompt name, used to reference it everywhere. Slug-like, e.g. "customer-support".'),
      description: z.string().optional().describe('What this prompt is for.'),
    },
    async handler({ name, description }, { client, config }) {
      const created = await client.post<{ id: string; name: string }>('/prompts', {
        name,
        description,
      });
      return okResult(
        `Created prompt "${created.name}" (${created.id}). It has no versions yet — ` +
          'commit one with commit_prompt_version.',
        created,
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'commit_prompt_version',
    title: 'Commit a prompt version',
    toolset: 'prompts',
    readOnlyHint: false,
    description:
      'Commit a new immutable version of a prompt. Version numbers are sequential per ' +
      'prompt. The FIRST commit auto-creates the "production" and "staging" aliases ' +
      'pointing at v1; every later commit changes no alias at all, so nothing goes live ' +
      'until you call promote_prompt_alias. Template variables are extracted from the ' +
      '{{ }} placeholders automatically.',
    inputSchema: {
      prompt: promptRef,
      messages: z
        .array(messageSchema)
        .min(1)
        .describe('The message template, in order. Use {{ variable }} for substitutions.'),
      model: z
        .string()
        .optional()
        .describe(
          'Optional default gateway model for this version, by public name (e.g. ' +
            '"gpt-4o-mini"). Must already be registered for the team.',
        ),
    },
    async handler({ prompt, messages, model }, { client, config }) {
      const id = await resolvePromptRef(client, prompt);
      const version = await client.post<{
        versionNumber: number;
        variables?: string[];
        aliases?: unknown[];
      }>(`/prompts/${id}/versions`, { messages, model });
      const aliasNote = version.aliases
        ? ' Aliases production and staging were created pointing at it.'
        : ' No alias moved — promote it when you want it live.';
      return okResult(
        `Committed version ${version.versionNumber} with variables [${(version.variables ?? []).join(
          ', ',
        )}].${aliasNote}`,
        version,
        config.maxTextBytes,
      );
    },
  }),

  defineTool({
    name: 'promote_prompt_alias',
    title: 'Promote an alias to a version',
    toolset: 'prompts',
    readOnlyHint: false,
    destructiveHint: true,
    description:
      'Point an alias at a specific version number, creating the alias if it does not ' +
      'exist. This is how a change ships, and how a rollback happens — promoting an ' +
      'earlier version number rolls back. Promoting "production" changes what live ' +
      'traffic renders immediately.',
    inputSchema: {
      prompt: promptRef,
      alias: z
        .string()
        .min(1)
        .describe('Alias to move, e.g. "production", "staging", "canary".'),
      version_number: z.number().int().positive().describe('Version number to point at.'),
    },
    async handler({ prompt, alias, version_number }, { client, config }) {
      const id = await resolvePromptRef(client, prompt);
      const result = await client.post<Record<string, unknown>>(
        `/prompts/${id}/aliases/${encodeURIComponent(alias)}/promote`,
        { version_number },
      );
      return okResult(
        `Alias "${alias}" now points at version ${version_number}.`,
        result,
        config.maxTextBytes,
      );
    },
  }),
];
