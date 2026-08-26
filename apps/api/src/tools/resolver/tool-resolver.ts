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

/**
 * Why one ref did not resolve. Each value is a different mistake with a different fix,
 * and collapsing them into one 404 is what made the endpoint's error unactionable: a
 * tool that exists but has no committed version read as "the tool does not exist"
 * (issue #349).
 */
export type ToolRefFailureReason =
  /** Nothing in this team is named that. A typo, or a tool that was never created. */
  | 'no_such_tool'
  /** The shell exists but nothing has been committed to it, so it has no aliases at all. */
  | 'no_versions'
  /** Versions exist; that alias was never promoted. */
  | 'unknown_alias'
  /** A pinned version number that was never committed. */
  | 'unknown_version';

/** One failing ref, as it was effectively looked up, plus why it failed and what exists. */
export interface ToolRefFailure {
  /** The ref as it was *effectively* asked for — a pin by version, an alias-follower with the default filled in. */
  ref: ToolRef;
  reason: ToolRefFailureReason;
  /** Alias names the tool does have, for `unknown_alias`. Absent when the tool itself is missing. */
  availableAliases?: string[];
  /** Highest committed version number, for `unknown_version`. */
  latestVersion?: number;
}

/** How one ref reads in an error message: `'get_weather'@production` or `'get_weather' v3`. */
function describeRef(ref: ToolRef): string {
  if (ref.version !== undefined) return `'${ref.name}' v${ref.version}`;
  return `'${ref.name}'@${ref.alias ?? 'production'}`;
}

/**
 * The one-sentence explanation for a failure: what is wrong, and the call that fixes it.
 *
 * Written in the style of the SDK's `MISSING_DISPATCH` message, which reads well because
 * it names the thing and what to pass. Creating a tool is two calls — `POST /tools` makes
 * the shell, `POST /tools/:id/versions` commits the version — so "exists but is not
 * callable" is the most likely first error a new user hits, and the message has to say so
 * rather than leaving them to read it as "no such tool".
 *
 * @param failure - The failing ref plus its reason and whatever context was found.
 * @returns A sentence naming the tool, the cause, and the next step.
 */
export function describeToolRefFailure(failure: ToolRefFailure): string {
  const { ref, reason } = failure;
  const name = `'${ref.name}'`;
  switch (reason) {
    case 'no_such_tool':
      return `no tool named ${name} in this team`;
    case 'no_versions':
      return (
        `tool ${name} has no versions, so alias '${ref.alias ?? 'production'}' does not ` +
        `exist yet — commit one with POST /tools/:id/versions`
      );
    case 'unknown_alias': {
      const have = failure.availableAliases?.length
        ? `; it has ${failure.availableAliases.map((a) => `'${a}'`).join(', ')}`
        : '';
      return `tool ${name} has no alias '${ref.alias ?? 'production'}'${have}`;
    }
    case 'unknown_version':
      return (
        `tool ${name} has no version ${ref.version}` +
        (failure.latestVersion !== undefined ? `; the latest is ${failure.latestVersion}` : '')
      );
  }
}

/** Thrown when a `tool_ref` cannot be resolved to a committed version. */
export class ToolRefNotFoundError extends Error {
  constructor(public readonly ref: ToolRef, public readonly failure?: ToolRefFailure) {
    super(
      failure
        ? `Could not resolve ${describeRef(ref)}: ${describeToolRefFailure(failure)}.`
        : ref.version !== undefined
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
 *
 * `refs` stays a plain `ToolRef[]` because it is serialised into the 404 body and callers
 * already read it; `failures` is the same list with the reason attached.
 */
export class ToolRefsNotFoundError extends Error {
  public readonly refs: ToolRef[];

  constructor(public readonly failures: ToolRefFailure[]) {
    super(
      `Could not resolve ${failures.length} tool ref(s): ` +
        failures.map((f) => `${describeRef(f.ref)} — ${describeToolRefFailure(f)}`).join('; '),
    );
    this.name = 'ToolRefsNotFoundError';
    this.refs = failures.map((f) => f.ref);
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
      const looked = await this.lookupRef(teamId, ref, ToolResolver.asAsked(ref));
      if (!looked.found) throw new ToolRefNotFoundError(ref, looked.failure);
      const { tool, version } = looked;
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
   * Resolves one ref to its tool row and committed version row, or explains which hop
   * failed. Shared by both public resolve methods so a pinned ref (`version`) and an
   * alias-following ref cannot drift apart in how they look a build up.
   *
   * The failure branch does one extra query — the tool's alias list, or its highest
   * version number — and only on the way to a 404, so the resolving path pays nothing
   * for it. That query is what turns "could not resolve" into a sentence naming the
   * cause (issue #349).
   *
   * @param teamId - Owning team (isolation boundary).
   * @param ref - The reference to resolve; `version` wins and skips the alias hop.
   * @param asAsked - The ref as it was effectively looked up, carried into the failure.
   * @returns Either the tool and version rows, or the failure with its reason.
   */
  private async lookupRef(
    teamId: string,
    ref: ToolRef,
    asAsked: ToolRef,
  ): Promise<
    | { found: true; tool: { id: string; name: string; description: string | null }; version: ToolVersionRow }
    | { found: false; failure: ToolRefFailure }
  > {
    const tool = await this.tools.findByName(ref.name, teamId);
    if (!tool) return { found: false, failure: { ref: asAsked, reason: 'no_such_tool' } };

    // A pin names its build outright — never consult an alias, whose target may have
    // moved on since the pin was made. That is the entire point of pinning.
    const versionNumber =
      ref.version ?? (await this.aliases.findByAlias(tool.id, ref.alias ?? 'production'))?.versionNumber;

    if (versionNumber === undefined) {
      // No alias matched. A tool with NO aliases at all is a shell whose version was
      // never committed — a different mistake from asking for an alias that was never
      // promoted, and by far the more common one, since creating a tool is two calls.
      const aliases = await this.aliases.listByTool(tool.id);
      return aliases.length === 0
        ? { found: false, failure: { ref: asAsked, reason: 'no_versions' } }
        : {
            found: false,
            failure: {
              ref: asAsked,
              reason: 'unknown_alias',
              availableAliases: aliases.map((a) => a.alias),
            },
          };
    }

    const version = await this.versions.findByVersionNumber(tool.id, versionNumber);
    if (!version) {
      // Only reachable for a pin: an alias's target version always exists (FK).
      const next = await this.versions.computeNextVersionNumber(tool.id);
      return {
        found: false,
        failure: {
          ref: asAsked,
          reason: next === 1 ? 'no_versions' : 'unknown_version',
          ...(next > 1 ? { latestVersion: next - 1 } : {}),
        },
      };
    }
    return { found: true, tool, version };
  }

  /**
   * The ref as it was *effectively* asked for — a pin by its version, an alias-follower
   * with the default alias filled in — so a caller reading the 404 sees what was actually
   * looked up rather than what they happened to omit.
   */
  private static asAsked(ref: ToolRef): ToolRef {
    return ref.version !== undefined
      ? { name: ref.name, version: ref.version }
      : { name: ref.name, alias: ref.alias ?? 'production' };
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
   *   array names every failure, each carrying whichever of the two it was looked up by,
   *   and its `failures` array adds why each one failed.
   */
  async resolveRefsDetailed(teamId: string, refs: ToolRef[]): Promise<DetailedResolvedTool[]> {
    const out: DetailedResolvedTool[] = [];
    const failed: ToolRefFailure[] = [];

    for (const ref of refs) {
      const looked = await this.lookupRef(teamId, ref, ToolResolver.asAsked(ref));
      if (!looked.found) {
        failed.push(looked.failure);
        continue;
      }
      const { tool, version } = looked;

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
