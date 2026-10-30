import type { Prisma, PrismaClient } from '@prisma/client';
import { audit } from '../../shared/audit';
import type { TemplateContent } from '../versions/nunjucks.utils';

/**
 * Repository for the import feature.
 * Its writes run in the caller's transaction, under the caller's name lock.
 */
export class ImportRepository {
  /**
   * Creates a new prompt, its first version (version_number = 1),
   * `production` and `staging` aliases pointing to that version,
   * and writes a `prompt_created` audit event.
   *
   * Writes only: the caller picks a free name and holds its prompt-name lock in `tx`,
   * so all four writes land in the same transaction as that check.
   *
   * @param params.teamId      - UUID of the team.
   * @param params.actorId     - UUID of the user performing the import.
   * @param params.name        - A name the caller has locked and found free.
   * @param params.description - Optional description from the export file.
   * @param params.messages    - Message array from the export file.
   * @param params.variables   - Re-derived variable list from nunjucks AST parse.
   * @param tx                 - The caller's transaction.
   * @returns IDs and version number for the response body.
   */
  async createImportedPrompt(
    params: {
      teamId:      string;
      actorId:     string;
      name:        string;
      description: string | null;
      messages:    Array<{ role: string; content: TemplateContent }>;
      variables:   string[];
    },
    tx: Prisma.TransactionClient,
  ): Promise<{ promptId: string; versionId: string; versionNumber: number }> {
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
  }
}
