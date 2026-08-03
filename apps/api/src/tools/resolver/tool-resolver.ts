import { ToolsRepository } from '../tools.repository';
import { ToolAliasesRepository } from '../aliases/aliases.repository';
import { ToolVersionsRepository } from '../versions/versions.repository';

/** OpenAI-shaped tool definition (kept structurally identical to the gateway's ToolDefinition). */
export interface ResolvedToolDefinition {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

/** A catalog reference: a tool name plus an optional alias (defaults to `production`). */
export interface ToolRef {
  name: string;
  alias?: string;
}

/**
 * What `POST /tools/resolve` returns per ref: the OpenAI-shaped function the model
 * needs, plus the three facts an SDK loop needs in order to decide who runs the tool.
 *
 * `executorType` is exposed instead of the whole executor on purpose. An `http`
 * executor holds urls, headers and `{{secret.NAME}}` references that must not leave the
 * server — the type alone is enough for a caller to know whether to run the tool itself
 * or ask the platform to.
 */
export interface DetailedResolvedTool {
  toolId: string;
  versionNumber: number;
  executorType: 'client' | 'http';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

/** Thrown when a `tool_ref` cannot be resolved to a committed version. */
export class ToolRefNotFoundError extends Error {
  constructor(public readonly ref: ToolRef) {
    super(`Tool '${ref.name}'${ref.alias ? ` @${ref.alias}` : ''} could not be resolved.`);
    this.name = 'ToolRefNotFoundError';
  }
}

/**
 * Thrown when one or more refs in a BATCH resolve cannot be resolved. Carries every
 * failure rather than the first, so a caller with five tools and two typos learns about
 * both in one response instead of fixing them one deploy at a time.
 */
export class ToolRefsNotFoundError extends Error {
  constructor(public readonly refs: ToolRef[]) {
    super(
      `Could not resolve ${refs.length} tool ref(s): ` +
        refs.map((r) => `'${r.name}'@${r.alias ?? 'production'}`).join(', '),
    );
    this.name = 'ToolRefsNotFoundError';
  }
}

/**
 * Resolves catalog tool references to OpenAI tool definitions, team-scoped.
 * Each ref resolves by (team, tool name) → alias (default 'production') → version →
 * `{ name, description, parameters: parametersSchema }`.
 */
export class ToolResolver {
  private readonly tools = new ToolsRepository();
  private readonly aliases = new ToolAliasesRepository();
  private readonly versions = new ToolVersionsRepository();

  /**
   * Resolves an array of refs to OpenAI tool definitions.
   *
   * @param teamId - Owning team (RLS scope).
   * @param refs - Catalog references to resolve.
   * @returns One `ResolvedToolDefinition` per ref, in input order.
   * @throws {ToolRefNotFoundError} When a tool/alias/version is missing.
   */
  async resolveRefs(teamId: string, refs: ToolRef[]): Promise<ResolvedToolDefinition[]> {
    const out: ResolvedToolDefinition[] = [];
    for (const ref of refs) {
      const tool = await this.tools.findByName(ref.name, teamId);
      if (!tool) throw new ToolRefNotFoundError(ref);
      const alias = await this.aliases.findByAlias(tool.id, ref.alias ?? 'production');
      if (!alias) throw new ToolRefNotFoundError(ref);
      const version = await this.versions.findByVersionNumber(tool.id, alias.versionNumber);
      if (!version) throw new ToolRefNotFoundError(ref);
      // parametersSchema is stored as Prisma JsonValue; the tool catalog (TC1) only
      // accepts JSON *object* schemas at commit time (see versions.types.ts), so this
      // cast is safe by contract, not by runtime narrowing.
      const parameters = version.parametersSchema as Record<string, unknown>;
      out.push({
        type: 'function',
        function: {
          name: tool.name,
          ...(version.description ?? tool.description ? { description: version.description ?? tool.description ?? undefined } : {}),
          parameters,
        },
      });
    }
    return out;
  }

  /**
   * Batch-resolves refs by name, collecting every failure before throwing.
   *
   * Kept separate from {@link resolveRefs} rather than replacing it: the gateway
   * (`gateway.service.ts`) relies on that method throwing {@link ToolRefNotFoundError}
   * for the first bad ref, and changing it would alter an error contract the completions
   * path already depends on.
   *
   * @param teamId - Owning team (isolation boundary).
   * @param refs - Catalog references to resolve. Each ref's alias defaults to `production`.
   * @returns One {@link DetailedResolvedTool} per ref, in input order, so a caller can zip
   *   the results against the refs it sent.
   * @throws {ToolRefsNotFoundError} When at least one ref does not resolve; its `refs`
   *   array names every failure, each with its effective alias filled in.
   */
  async resolveRefsDetailed(teamId: string, refs: ToolRef[]): Promise<DetailedResolvedTool[]> {
    const out: DetailedResolvedTool[] = [];
    const failed: ToolRef[] = [];

    for (const ref of refs) {
      const alias = ref.alias ?? 'production';
      const tool = await this.tools.findByName(ref.name, teamId);
      if (!tool) {
        failed.push({ name: ref.name, alias });
        continue;
      }
      const aliasRow = await this.aliases.findByAlias(tool.id, alias);
      if (!aliasRow) {
        failed.push({ name: ref.name, alias });
        continue;
      }
      const version = await this.versions.findByVersionNumber(tool.id, aliasRow.versionNumber);
      if (!version) {
        failed.push({ name: ref.name, alias });
        continue;
      }

      const executor = version.executor as unknown as { type: 'client' | 'http' };
      // Same precedence as resolveRefs: the version's description wins, falling back to
      // the tool's. `changelog` is never consulted — that is the entire point of it
      // being a separate column.
      const description = version.description ?? tool.description ?? undefined;
      out.push({
        toolId: tool.id,
        versionNumber: version.versionNumber,
        executorType: executor.type,
        function: {
          name: tool.name,
          ...(description !== undefined ? { description } : {}),
          // parametersSchema is a Prisma JsonValue; the catalog only accepts JSON
          // *object* schemas at commit time, so this cast is safe by contract.
          parameters: version.parametersSchema as Record<string, unknown>,
        },
      });
    }

    if (failed.length > 0) throw new ToolRefsNotFoundError(failed);
    return out;
  }
}
