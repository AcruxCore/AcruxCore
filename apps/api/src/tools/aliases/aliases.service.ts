import { ToolAliasesRepository } from './aliases.repository';
import { ToolVersionsRepository } from '../versions/versions.repository';
import { ToolsRepository } from '../tools.repository';
import { AliasDetail, PromoteToolAliasDto } from './aliases.types';
import { NotFoundError } from '../../shared/errors';
import { audit } from '../../shared/audit';
import prisma from '../../shared/db/client';

/**
 * Business logic for tool aliases: listing and promoting/rolling back the
 * alias→version pointer. Mirrors `prompts/aliases/aliases.service.ts`.
 */
export class ToolAliasesService {
  private readonly aliasesRepo = new ToolAliasesRepository();
  private readonly versionsRepo = new ToolVersionsRepository();
  private readonly toolsRepo = new ToolsRepository();

  /**
   * Verifies a tool exists and belongs to the team, throwing NotFoundError if not.
   *
   * @param toolId - UUID of the tool to verify.
   * @param teamId - UUID of the authenticated user's team.
   * @throws {NotFoundError} If the tool is not found, belongs to another team, or is deleted.
   */
  private async assertToolAccessible(toolId: string, teamId: string): Promise<void> {
    const tool = await this.toolsRepo.findById(toolId, teamId);
    if (!tool) throw new NotFoundError('Tool not found.');
  }

  /**
   * Lists all aliases for a tool, joined with their target version number.
   *
   * @param toolId - UUID of the tool.
   * @param teamId - UUID of the authenticated user's team.
   * @returns Wrapped array of alias details (`{ data }`).
   * @throws {NotFoundError} If the tool is not found.
   */
  async listAliases(toolId: string, teamId: string): Promise<{ data: AliasDetail[] }> {
    await this.assertToolAccessible(toolId, teamId);
    return { data: await this.aliasesRepo.listByTool(toolId) };
  }

  /**
   * Points an alias at a target version (promotion or rollback — same operation).
   *
   * Steps:
   * 1. Verifies tool exists in team.
   * 2. Verifies the target version_number exists for this tool.
   * 3. Captures the current alias state (for audit fromVersionNumber).
   * 4. Upserts the alias row.
   * 5. Emits audit event 'tool_alias_promoted'.
   *
   * @param toolId - UUID of the tool.
   * @param teamId - UUID of the authenticated user's team.
   * @param userId - UUID of the acting user.
   * @param alias - The alias name to promote (e.g. 'production').
   * @param dto - Validated body containing version_number.
   * @returns The updated alias detail.
   * @throws {NotFoundError} If the tool or the target version is not found.
   */
  async promoteAlias(
    toolId: string,
    teamId: string,
    userId: string,
    alias: string,
    dto: PromoteToolAliasDto,
  ): Promise<AliasDetail> {
    await this.assertToolAccessible(toolId, teamId);

    const target = await this.versionsRepo.findByVersionNumber(toolId, dto.version_number);
    if (!target) throw new NotFoundError(`Version ${dto.version_number} not found for this tool.`);

    const current = await this.aliasesRepo.findByAlias(toolId, alias);
    const result = await this.aliasesRepo.upsertAlias(toolId, alias, target.id);

    void audit(prisma, {
      teamId,
      actorId: userId,
      event: 'tool_alias_promoted',
      metadata: {
        toolId,
        alias,
        fromVersionNumber: current?.versionNumber ?? null,
        toVersionNumber: dto.version_number,
      },
    });

    return result;
  }
}
