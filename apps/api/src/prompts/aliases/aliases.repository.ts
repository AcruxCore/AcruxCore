import prisma from '../../shared/db/client';
import type { AliasDetail, AliasWithVersion } from './aliases.types';

/**
 * Data-access class for the prompt_aliases table.
 * All queries for prompt aliases go through this class.
 */
export class AliasesRepository {
  /**
   * Inserts 'production' and 'staging' alias rows both pointing to the given version.
   * Called exactly once per prompt — when the first version is committed.
   *
   * @param promptId - UUID of the parent prompt.
   * @param versionId - UUID of the first prompt_versions row.
   * @returns Array of two AliasDetail objects (production, staging).
   */
  async autoCreateAliases(promptId: string, versionId: string): Promise<AliasDetail[]> {
    const versionRow = await prisma.promptVersion.findUnique({
      where: { id: versionId },
      select: { versionNumber: true },
    });

    const versionNumber = versionRow?.versionNumber ?? 1;
    const now = new Date();

    const [production, staging] = await prisma.$transaction([
      prisma.promptAlias.create({
        data: { promptId, alias: 'production', versionId, updatedAt: now },
      }),
      prisma.promptAlias.create({
        data: { promptId, alias: 'staging', versionId, updatedAt: now },
      }),
    ]);

    return [production, staging].map((r) => ({
      id: r.id,
      alias: r.alias,
      versionId: r.versionId,
      versionNumber,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * Finds a single alias by (prompt_id, alias) with its target version number.
   * Returns null if the alias does not exist.
   *
   * @param promptId - UUID of the parent prompt.
   * @param alias - The alias name (e.g. 'production').
   * @returns The alias with its target versionNumber, or null.
   */
  async findByAlias(
    promptId: string,
    alias: string,
  ): Promise<AliasDetail | null> {
    const row = await prisma.promptAlias.findUnique({
      where: { uq_prompt_aliases_prompt_alias: { promptId, alias } },
      include: { version: { select: { versionNumber: true } } },
    });

    if (!row) return null;
    return {
      id: row.id,
      alias: row.alias,
      versionId: row.versionId,
      versionNumber: row.version.versionNumber,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Finds an alias by prompt name + alias name within a team.
   * Joins prompts → prompt_aliases → prompt_versions to return the full version content.
   * This is the lookup used by the render endpoint.
   *
   * @param teamId - UUID of the team (for prompt ownership check).
   * @param promptName - Mutable display name of the prompt.
   * @param alias - The alias name (e.g. 'production').
   * @returns Full alias + version data, or null if not found.
   */
  async findByPromptName(
    teamId: string,
    promptName: string,
    alias: string,
  ): Promise<AliasWithVersion | null> {
    const row = await prisma.promptAlias.findFirst({
      where: {
        alias,
        prompt: { teamId, name: promptName, deletedAt: null },
      },
      include: {
        version: {
          select: {
            versionNumber: true,
            messages: true,
            variables: true,
            model: { select: { publicName: true } },
          },
        },
      },
    });

    if (!row) return null;
    return {
      aliasId: row.id,
      alias: row.alias,
      versionId: row.versionId,
      versionNumber: row.version.versionNumber,
      messages: row.version.messages as Array<{ role: string; content: string }>,
      variables: row.version.variables as string[],
      model: row.version.model?.publicName ?? null,
    };
  }

  /**
   * Lists all aliases for a prompt with their target version numbers.
   *
   * @param promptId - UUID of the parent prompt.
   * @returns Array of alias details, joined with version number.
   */
  async listByPrompt(promptId: string): Promise<AliasDetail[]> {
    const rows = await prisma.promptAlias.findMany({
      where: { promptId },
      include: { version: { select: { versionNumber: true } } },
    });

    return rows.map((r) => ({
      id: r.id,
      alias: r.alias,
      versionId: r.versionId,
      versionNumber: r.version.versionNumber,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * Upserts an alias row — inserts if the (prompt_id, alias) doesn't exist,
   * updates version_id and updated_at if it does.
   * This implements both promotion (forward) and rollback (backward).
   *
   * @param promptId - UUID of the parent prompt.
   * @param alias - The alias name.
   * @param versionId - UUID of the target prompt_versions row.
   * @returns The upserted alias with its version number.
   */
  /**
   * Deletes an alias row by (prompt_id, alias).
   *
   * @param promptId - UUID of the parent prompt.
   * @param alias - The alias name to delete.
   * @returns true if deleted, false if the row did not exist.
   */
  async deleteAlias(promptId: string, alias: string): Promise<boolean> {
    const result = await prisma.promptAlias.deleteMany({
      where: { promptId, alias },
    });
    return result.count > 0;
  }

  async upsertAlias(promptId: string, alias: string, versionId: string): Promise<AliasDetail> {
    const versionRow = await prisma.promptVersion.findUnique({
      where: { id: versionId },
      select: { versionNumber: true },
    });

    if (!versionRow) {
      // Should not happen — callers validate versionId exists before calling
      throw new Error(`Version row not found for versionId: ${versionId}`);
    }

    const row = await prisma.promptAlias.upsert({
      where: { uq_prompt_aliases_prompt_alias: { promptId, alias } },
      create: { promptId, alias, versionId, updatedAt: new Date() },
      update: { versionId, updatedAt: new Date() },
    });

    return {
      id: row.id,
      alias: row.alias,
      versionId: row.versionId,
      versionNumber: versionRow.versionNumber,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
