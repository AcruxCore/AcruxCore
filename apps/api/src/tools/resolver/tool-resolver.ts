import { ToolsRepository } from '../tools.repository';
import { ToolAliasesRepository } from '../aliases/aliases.repository';
import { ToolVersionsRepository } from '../versions/versions.repository';
import type { ToolVersionRow } from '../versions/versions.types';

/** OpenAI-shaped tool definition (kept structurally identical to the gateway's ToolDefinition). */
export interface ResolvedToolDefinition {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

/**
 * A catalog reference: a tool name plus either an alias to follow (defaults to
 * `production`) or one exact version to pin.
 *
 * `alias` and `version` are mutually exclusive — a ref either follows a moving alias or
 * names a fixed build, never both. `version` exists so a prompt's *pinned* tool binding
 * survives the trip through `tool_refs`: without it a caller holding a pin would have to
 * send the alias instead, silently running a different build than the one pinned.
 */
export interface ToolRef {
  name: string;
  alias?: string;
  /** Exact version number to resolve, instead of following an alias. */
  version?: number;
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

/** How one ref reads in an error message: `'get_weather'@production` or `'get_weather' v3`. */
function describeRef(ref: ToolRef): string {
  if (ref.version !== undefined) return `'${ref.name}' v${ref.version}`;
  return `'${ref.name}'@${ref.alias ?? 'production'}`;
}

/** Thrown when a `tool_ref` cannot be resolved to a committed version. */
export class ToolRefNotFoundError extends Error {
  constructor(public readonly ref: ToolRef) {
    super(
      ref.version !== undefined
        ? `Tool '${ref.name}' v${ref.version} could not be resolved.`
        : `Tool '${ref.name}'${ref.alias ? ` @${ref.alias}` : ''} could not be resolved.`,
    );
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
    super(`Could not resolve ${refs.length} tool ref(s): ` + refs.map(describeRef).join(', '));
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
      const found = await this.lookupRef(teamId, ref);
      if (!found) throw new ToolRefNotFoundError(ref);
      const { tool, version } = found;
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
   * Resolves one ref to its tool row and committed version row, or `null` when any hop
   * is missing. Shared by both public resolve methods so a pinned ref (`version`) and an
   * alias-following ref cannot drift apart in how they look a build up.
   *
   * @param teamId - Owning team (isolation boundary).
   * @param ref - The reference to resolve; `version` wins and skips the alias hop.
   * @returns The tool and version rows, or `null` if the tool, alias or version is gone.
   */
  private async lookupRef(
    teamId: string,
    ref: ToolRef,
  ): Promise<{ tool: { id: string; name: string; description: string | null }; version: ToolVersionRow } | null> {
    const tool = await this.tools.findByName(ref.name, teamId);
    if (!tool) return null;

    // A pin names its build outright — never consult an alias, whose target may have
    // moved on since the pin was made. That is the entire point of pinning.
    const versionNumber =
      ref.version ?? (await this.aliases.findByAlias(tool.id, ref.alias ?? 'production'))?.versionNumber;
    if (versionNumber === undefined) return null;

    const version = await this.versions.findByVersionNumber(tool.id, versionNumber);
    if (!version) return null;
    return { tool, version };
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
   * @param refs - Catalog references to resolve. A ref's `version` pins one exact build;
   *   otherwise its alias is followed, defaulting to `production`.
   * @returns One {@link DetailedResolvedTool} per ref, in input order, so a caller can zip
   *   the results against the refs it sent.
   * @throws {ToolRefsNotFoundError} When at least one ref does not resolve; its `refs`
   *   array names every failure, each carrying whichever of the two it was looked up by.
   */
  async resolveRefsDetailed(teamId: string, refs: ToolRef[]): Promise<DetailedResolvedTool[]> {
    const out: DetailedResolvedTool[] = [];
    const failed: ToolRef[] = [];

    for (const ref of refs) {
      // A failure reports back the ref as it was *effectively* asked for — a pin by its
      // version, an alias-follower with the default alias filled in — so a caller reading
      // the 404 sees what was actually looked up.
      const asAsked: ToolRef =
        ref.version !== undefined
          ? { name: ref.name, version: ref.version }
          : { name: ref.name, alias: ref.alias ?? 'production' };

      const found = await this.lookupRef(teamId, ref);
      if (!found) {
        failed.push(asAsked);
        continue;
      }
      const { tool, version } = found;

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
