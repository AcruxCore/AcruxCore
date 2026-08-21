import { ToolBindingsRepository, BindingRow } from './tool-bindings.repository';
import { PromptsRepository } from '../prompts.repository';
import { AliasesRepository } from '../aliases/aliases.repository';
import { ToolsRepository } from '../../tools/tools.repository';
import { ToolAliasesRepository } from '../../tools/aliases/aliases.repository';
import { ToolVersionsRepository } from '../../tools/versions/versions.repository';
import { AliasBindings, BindingDetail, PromptBindings, SetBindingDto } from './tool-bindings.types';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { audit } from '../../shared/audit';
import prisma from '../../shared/db/client';

/**
 * Business logic for prompt→tool bindings (phase-4-faq Q53).
 *
 * A binding says: "when this prompt is served through this alias, call this tool
 * at this tool alias." It is not tied to any prompt version — set once, it
 * survives new commits and alias promotions on both sides until changed. A
 * NULL-alias default row applies to every alias with no row of its own, which is
 * what stops a newly promoted alias from rendering with zero tools.
 */
export class ToolBindingsService {
  private readonly bindingsRepo = new ToolBindingsRepository();
  private readonly promptsRepo = new PromptsRepository();
  private readonly promptAliasesRepo = new AliasesRepository();
  private readonly toolsRepo = new ToolsRepository();
  private readonly toolAliasesRepo = new ToolAliasesRepository();
  private readonly toolVersionsRepo = new ToolVersionsRepository();

  /** Verifies a prompt exists and belongs to the team. */
  private async assertPromptAccessible(promptId: string, teamId: string): Promise<void> {
    const prompt = await this.promptsRepo.findById(promptId, teamId);
    if (!prompt) throw new NotFoundError('Prompt not found.');
  }

  /**
   * Turns a request body into the two nullable columns a row stores, validating
   * that whatever it names actually exists on the tool right now.
   *
   * Failing here rather than at render time is deliberate: a binding that names a
   * missing alias would go quietly dormant, and the author would not find out
   * until a call came in without the tool.
   *
   * @throws {ValidationError} If the named tool alias or version does not exist.
   */
  private async resolveValue(
    toolId: string,
    toolName: string,
    dto: SetBindingDto,
  ): Promise<{ toolAlias: string | null; pinnedVersionId: string | null }> {
    if (dto.off) return { toolAlias: null, pinnedVersionId: null };

    if (dto.pinned_version_number !== undefined) {
      const version = await this.toolVersionsRepo.findByVersionNumber(toolId, dto.pinned_version_number);
      if (!version) {
        throw new ValidationError(`Tool '${toolName}' has no version ${dto.pinned_version_number}.`);
      }
      return { toolAlias: null, pinnedVersionId: version.id };
    }

    const alias = await this.toolAliasesRepo.findByAlias(toolId, dto.tool_alias as string);
    if (!alias) {
      throw new ValidationError(await this.explainMissingToolAlias(toolId, toolName, dto.tool_alias as string));
    }
    return { toolAlias: dto.tool_alias as string, pinnedVersionId: null };
  }

  /**
   * Builds the message for a binding that names a tool alias the tool does not
   * have. The common cause is a tool created as a name only and never committed:
   * aliases are auto-created by the first version, so a bare tool has none at
   * all, and "no alias 'production'" on its own reads like a typo rather than
   * missing setup. So the message names which of the three situations it is and
   * the next step out of it.
   *
   * @param toolId - UUID of the tool the binding points at.
   * @param toolName - Tool name, for a message the caller can act on without a lookup.
   * @param wanted - The alias the caller asked for.
   * @returns The full error message; the caller throws it.
   */
  private async explainMissingToolAlias(
    toolId: string,
    toolName: string,
    wanted: string,
  ): Promise<string> {
    const available = await this.toolAliasesRepo.listByTool(toolId);

    if (available.length > 0) {
      const names = available.map((a) => `'${a.alias}'`).join(', ');
      return (
        `Tool '${toolName}' has no alias '${wanted}'. It has ${names}. ` +
        `Create '${wanted}' on the tool's Aliases tab first, or bind to a fixed version with ` +
        `"pinned_version_number" instead of "tool_alias".`
      );
    }

    const { total } = await this.toolVersionsRepo.listByTool(toolId, 1, 1);
    if (total === 0) {
      return (
        `Tool '${toolName}' has no alias '${wanted}' because it has no versions yet — ` +
        `it exists as a name only. Commit a first version of '${toolName}' (description, ` +
        `parameters and executor); that creates its 'production' and 'staging' aliases, and the ` +
        `binding will then work.`
      );
    }

    return (
      `Tool '${toolName}' has no alias '${wanted}'. It has ${total} version(s) but no aliases at all. ` +
      `Point an alias at a version on the tool's Aliases tab, or bind to a fixed version with ` +
      `"pinned_version_number" instead of "tool_alias".`
    );
  }

  /**
   * Fills in each row's `resolvedVersionNumber` so a caller can show what will
   * actually run without a request per cell.
   */
  private async toDetails(rows: BindingRow[]): Promise<BindingDetail[]> {
    const out: BindingDetail[] = [];
    for (const row of rows) {
      const off = row.toolAlias === null && row.pinnedVersionId === null;
      let resolvedVersionNumber: number | null = null;
      let pinnedVersionNumber: number | null = null;

      if (row.pinnedVersionId) {
        const pinned = await this.toolVersionsRepo.findById(row.pinnedVersionId);
        pinnedVersionNumber = pinned?.versionNumber ?? null;
        resolvedVersionNumber = pinnedVersionNumber;
      } else if (row.toolAlias) {
        const alias = await this.toolAliasesRepo.findByAlias(row.toolId, row.toolAlias);
        resolvedVersionNumber = alias?.versionNumber ?? null;
      }

      out.push({
        toolId: row.toolId,
        toolName: row.toolName,
        toolAlias: row.toolAlias,
        pinnedVersionNumber,
        off,
        resolvedVersionNumber,
        position: row.position,
      });
    }
    return out;
  }

  /**
   * The whole binding picture for one prompt: the inherited default, plus every
   * alias that exists today with only its own rows and a `customised` flag.
   *
   * Aliases with no rows are still listed, so the dashboard can name them as
   * following the default without inventing a column for each.
   *
   * @param promptId - UUID of the prompt.
   * @param teamId - UUID of the authenticated user's team.
   * @throws {NotFoundError} If the prompt is not found.
   */
  async list(promptId: string, teamId: string): Promise<{ data: PromptBindings }> {
    await this.assertPromptAccessible(promptId, teamId);

    const rows = await this.bindingsRepo.listByPrompt(promptId);
    const promptAliases = await this.promptAliasesRepo.listByPrompt(promptId);

    const aliases: AliasBindings[] = [];
    for (const a of promptAliases) {
      const own = rows.filter((r) => r.promptAlias === a.alias);
      aliases.push({
        alias: a.alias,
        versionNumber: a.versionNumber,
        customised: own.length > 0,
        bindings: await this.toDetails(own),
      });
    }

    return {
      data: {
        default: await this.toDetails(rows.filter((r) => r.promptAlias === null)),
        aliases,
      },
    };
  }

  /**
   * Sets one binding, on the default when `promptAlias` is null or on that alias.
   *
   * Deliberately does NOT require `promptAlias` to exist as a `PromptAlias` row —
   * a binding can be set up before the alias is promoted, and survives it being
   * demoted and recreated, since it is keyed by name rather than row id.
   *
   * @param promptId - UUID of the prompt.
   * @param teamId - UUID of the authenticated user's team.
   * @param userId - UUID of the acting user.
   * @param promptAlias - Alias name, or null to write the inherited default.
   * @param toolId - UUID of the tool to bind.
   * @param dto - Validated body naming a tool alias, a pinned version, or `off`.
   * @returns The resulting binding detail.
   * @throws {NotFoundError} If the prompt or tool is not found.
   * @throws {ValidationError} If `off` is used on the default, or the named tool
   *   alias or version does not exist.
   */
  async set(
    promptId: string,
    teamId: string,
    userId: string,
    promptAlias: string | null,
    toolId: string,
    dto: SetBindingDto,
  ): Promise<BindingDetail> {
    await this.assertPromptAccessible(promptId, teamId);

    // "Off" only means something as a contradiction of a default. On the default
    // itself there is nothing to contradict, and the caller wants DELETE instead.
    if (dto.off && promptAlias === null) {
      throw new ValidationError(
        'off applies to a prompt alias, not the default. Delete the default binding instead.',
      );
    }

    const tool = await this.toolsRepo.findById(toolId, teamId);
    if (!tool) throw new NotFoundError('Tool not found.');

    const value = await this.resolveValue(toolId, tool.name, dto);
    const previous = await this.bindingsRepo.findOne(promptId, promptAlias, toolId);
    const position = previous
      ? 0 // ignored on update
      : await this.bindingsRepo.nextPosition(promptId, promptAlias);

    const row = await this.bindingsRepo.set(promptId, promptAlias, toolId, value, userId, position);

    void audit(prisma, {
      teamId,
      actorId: userId,
      event: 'prompt_tool_route_set',
      promptId,
      metadata: {
        toolId,
        toolName: tool.name,
        promptAlias,
        fromToolAlias: previous?.toolAlias ?? null,
        toToolAlias: value.toolAlias,
        pinned: value.pinnedVersionId !== null,
        off: dto.off === true,
      },
    });

    const [detail] = await this.toDetails([row]);
    return detail;
  }

  /**
   * Removes one binding. On an alias that returns the (alias, tool) pair to the
   * inherited default; on the default it unbinds the tool from the prompt
   * entirely, for every alias that was inheriting it.
   *
   * @param promptId - UUID of the prompt.
   * @param teamId - UUID of the authenticated user's team.
   * @param userId - UUID of the acting user.
   * @param promptAlias - Alias name, or null for the default row.
   * @param toolId - UUID of the tool.
   * @throws {NotFoundError} If the prompt is not found, or there was no binding.
   */
  async remove(
    promptId: string,
    teamId: string,
    userId: string,
    promptAlias: string | null,
    toolId: string,
  ): Promise<void> {
    await this.assertPromptAccessible(promptId, teamId);

    const previous = await this.bindingsRepo.findOne(promptId, promptAlias, toolId);
    const removed = await this.bindingsRepo.remove(promptId, promptAlias, toolId);
    if (!removed) throw new NotFoundError('No binding set for that tool.');

    void audit(prisma, {
      teamId,
      actorId: userId,
      event: 'prompt_tool_route_removed',
      promptId,
      metadata: { toolId, promptAlias, fromToolAlias: previous?.toolAlias ?? null },
    });
  }

  /**
   * Drops every row one alias owns, returning it wholesale to the default. Backs
   * the dashboard's per-column reset.
   *
   * @param promptId - UUID of the prompt.
   * @param teamId - UUID of the authenticated user's team.
   * @param userId - UUID of the acting user.
   * @param promptAlias - Alias name to reset.
   * @throws {NotFoundError} If the prompt is not found, or the alias had no rows.
   */
  async resetAlias(promptId: string, teamId: string, userId: string, promptAlias: string): Promise<void> {
    await this.assertPromptAccessible(promptId, teamId);

    const count = await this.bindingsRepo.removeAllForAlias(promptId, promptAlias);
    if (count === 0) throw new NotFoundError(`Alias '${promptAlias}' has no bindings of its own.`);

    void audit(prisma, {
      teamId,
      actorId: userId,
      event: 'prompt_tool_route_removed',
      promptId,
      metadata: { promptAlias, reset: true, removedCount: count },
    });
  }
}
