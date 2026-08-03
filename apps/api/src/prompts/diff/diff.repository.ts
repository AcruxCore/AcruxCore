import prisma from '../../shared/db/client';

/**
 * Repository for fetching the data needed to compute a version diff.
 * All queries are scoped by team_id to enforce tenant isolation.
 */
export class DiffRepository {
  /**
   * Checks whether a prompt exists and belongs to the given team.
   *
   * @param promptId - UUID of the prompt.
   * @param teamId   - UUID of the requesting team.
   * @returns The prompt's id and name if found, or undefined.
   */
  async findPrompt(
    promptId: string,
    teamId: string,
  ): Promise<{ id: string; name: string } | undefined> {
    const prompt = await prisma.prompt.findFirst({
      where: { id: promptId, teamId, deletedAt: null },
      select: { id: true, name: true },
    });
    return prompt ?? undefined;
  }

  /**
   * Fetches version rows by their version numbers for a given prompt.
   * Returns an array of 0, 1, or 2 rows — the caller checks count to detect missing versions.
   *
   * @param promptId       - UUID of the prompt.
   * @param versionNumbers - Array of one or two version numbers to fetch.
   * @returns Array of version rows with versionNumber and messages.
   */
  async findVersionsByNumbers(
    promptId: string,
    versionNumbers: number[],
  ): Promise<Array<{ versionNumber: number; messages: Array<{ role: string; content: string }> }>> {
    const rows = await prisma.promptVersion.findMany({
      where: { promptId, versionNumber: { in: versionNumbers } },
      select: { versionNumber: true, messages: true },
    });

    return rows as Array<{ versionNumber: number; messages: Array<{ role: string; content: string }> }>;
  }
}
