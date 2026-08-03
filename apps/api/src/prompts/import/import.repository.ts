import prisma from '../../shared/db/client';
import type { PrismaClient } from '@prisma/client';
import { audit } from '../../shared/audit';

/**
 * Repository for the import feature.
 * All mutations run inside a single Prisma transaction.
 */
export class ImportRepository {
  /**
   * Checks whether a prompt with the given name already exists in the team.
   *
   * @param name   - The prompt name to check.
   * @param teamId - The team scope.
   * @returns True if a live prompt with this name exists in the team.
   */
  async nameExistsInTeam(name: string, teamId: string): Promise<boolean> {
    const count = await prisma.prompt.count({
      where: { name, teamId, deletedAt: null },
    });
    return count > 0;
  }

  /**
   * Creates a new prompt, its first version (version_number = 1),
   * `production` and `staging` aliases pointing to that version,
   * and writes a `prompt_created` audit event.
   * All four operations run inside a single transaction.
   *
   * @param params.teamId      - UUID of the team.
   * @param params.actorId     - UUID of the user performing the import.
   * @param params.name        - Final prompt name (may have been suffixed for collision resolution).
   * @param params.description - Optional description from the export file.
   * @param params.messages    - Message array from the export file.
   * @param params.variables   - Re-derived variable list from nunjucks AST parse.
   * @returns IDs and version number for the response body.
   */
  async createImportedPrompt(params: {
    teamId:      string;
    actorId:     string;
    name:        string;
    description: string | null;
    messages:    Array<{ role: string; content: string }>;
    variables:   string[];
  }): Promise<{ promptId: string; versionId: string; versionNumber: number }> {
    return prisma.$transaction(async (tx) => {
      const newPrompt = await tx.prompt.create({
        data: {
          name:        params.name,
          description: params.description,
          teamId:      params.teamId,
          createdBy:   params.actorId,
        },
        select: { id: true },
      });

      const newVersion = await tx.promptVersion.create({
        data: {
          promptId:      newPrompt.id,
          versionNumber: 1,
          messages:      params.messages,
          variables:     params.variables,
          createdBy:     params.actorId,
        },
        select: { id: true, versionNumber: true },
      });

      await tx.promptAlias.createMany({
        data: [
          { promptId: newPrompt.id, alias: 'production', versionId: newVersion.id },
          { promptId: newPrompt.id, alias: 'staging',    versionId: newVersion.id },
        ],
      });

      // audit() expects PrismaClient but tx is Prisma.TransactionClient — compatible subset
      await audit(tx as unknown as PrismaClient, {
        teamId:   params.teamId,
        actorId:  params.actorId,
        event:    'prompt_created',
        promptId: newPrompt.id,
        metadata: { name: params.name },
      });

      return {
        promptId:      newPrompt.id,
        versionId:     newVersion.id,
        versionNumber: newVersion.versionNumber,
      };
    });
  }
}
