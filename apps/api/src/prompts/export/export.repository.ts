import prisma from '../../shared/db/client';

/**
 * Repository for fetching prompt and version data needed for export.
 */
export class ExportRepository {
  /**
   * Fetches a prompt by ID within a team scope.
   *
   * @param promptId - UUID of the prompt.
   * @param teamId   - UUID of the requesting team.
   * @returns Prompt name and description, or undefined if not found or deleted.
   */
  async findPrompt(
    promptId: string,
    teamId: string,
  ): Promise<{ id: string; name: string; description: string | null } | undefined> {
    const prompt = await prisma.prompt.findFirst({
      where: { id: promptId, teamId, deletedAt: null },
      select: { id: true, name: true, description: true },
    });
    return prompt ?? undefined;
  }

  /**
   * Fetches a specific version of a prompt by its version number.
   *
   * @param promptId      - UUID of the prompt.
   * @param versionNumber - The sequential version number (1, 2, 3…).
   * @returns Version data for export, or undefined if not found.
   */
  async findVersion(
    promptId: string,
    versionNumber: number,
  ): Promise<{
    versionNumber: number;
    messages:      Array<{ role: string; content: string }>;
    variables:     string[];
    createdAt:     Date;
  } | undefined> {
    const row = await prisma.promptVersion.findFirst({
      where: { promptId, versionNumber },
      select: { versionNumber: true, messages: true, variables: true, createdAt: true },
    });

    if (!row) return undefined;
    return {
      versionNumber: row.versionNumber,
      messages:      row.messages as Array<{ role: string; content: string }>,
      variables:     row.variables as string[],
      createdAt:     row.createdAt,
    };
  }
}
