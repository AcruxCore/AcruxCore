import prisma from '../../shared/db/client';
import type { PromptVersionRow, CreateVersionInput } from './versions.types';

/**
 * Data-access class for the prompt_versions table.
 * All queries for prompt versions go through this class — no other file imports prisma for this table.
 */
export class VersionsRepository {
  /**
   * Computes the next sequential version_number for a prompt.
   * Uses MAX(version_number) + 1, returning 1 for the first version.
   *
   * @param promptId - UUID of the prompt.
   * @returns The next version number to use (1-based).
   */
  async computeNextVersionNumber(promptId: string): Promise<number> {
    const result = await prisma.promptVersion.aggregate({
      where: { promptId },
      _max: { versionNumber: true },
    });
    return (result._max.versionNumber ?? 0) + 1;
  }

  /**
   * Inserts a new prompt_versions row.
   *
   * @param data - All fields required to create the version.
   * @returns The newly inserted row.
   */
  async create(data: CreateVersionInput): Promise<PromptVersionRow> {
    return prisma.promptVersion.create({
      data: {
        promptId: data.promptId,
        versionNumber: data.versionNumber,
        messages: data.messages,
        variables: data.variables,
        createdBy: data.createdBy,
        modelId: data.modelId ?? null,
      },
    });
  }

  /**
   * Fetches a version by its primary key UUID.
   *
   * This performs a GLOBAL lookup with no team scoping — it must only be used
   * by callers that have already resolved the id through a team-scoped path
   * (e.g. `promptId` was itself fetched via a team-scoped query first). Any
   * caller that receives a bare `promptVersionId` from an untrusted or
   * cross-team-reachable source (e.g. a background job payload) must use
   * `findByIdForTeam` instead.
   *
   * @param id - UUID of the prompt_versions row.
   * @returns The row, or null if not found.
   */
  async findById(id: string): Promise<PromptVersionRow | null> {
    return prisma.promptVersion.findUnique({ where: { id } });
  }

  /**
   * Fetches a version by its primary key UUID, scoped to a team via the
   * parent prompt's `teamId`. Use this whenever the id originates from a
   * source that could carry another team's id (e.g. a queued job payload),
   * per the "every query team_id-scoped" rule.
   *
   * @param id - UUID of the prompt_versions row.
   * @param teamId - The calling team's UUID (isolation boundary).
   * @returns The row, or null if not found or if it belongs to a different team.
   */
  async findByIdForTeam(id: string, teamId: string): Promise<PromptVersionRow | null> {
    return prisma.promptVersion.findFirst({
      where: { id, prompt: { teamId } },
    });
  }

  /**
   * Fetches a version by its (prompt_id, version_number) composite lookup.
   * Returns null if the version does not exist for this prompt.
   *
   * @param promptId - UUID of the parent prompt.
   * @param versionNumber - The 1-based sequential version number.
   * @returns The row, or null if not found.
   */
  async findByVersionNumber(
    promptId: string,
    versionNumber: number,
  ): Promise<(PromptVersionRow & { model: { publicName: string } | null }) | null> {
    return prisma.promptVersion.findUnique({
      where: { uq_prompt_versions_prompt_version: { promptId, versionNumber } },
      include: { model: { select: { publicName: true } } },
    });
  }

  /**
   * Lists versions for a prompt, newest first, with offset-based pagination.
   * messages column is excluded to keep payloads small — use findByVersionNumber for full content.
   *
   * @param promptId - UUID of the parent prompt.
   * @param page - 1-based page number.
   * @param limit - Items per page (max 100).
   * @returns Paginated rows (without messages) and total count.
   */
  async listByPrompt(
    promptId: string,
    page: number,
    limit: number,
  ): Promise<{
    rows: Array<
      Omit<PromptVersionRow, 'messages'> & { model: { publicName: string } | null }
    >;
    total: number;
  }> {
    const offset = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      prisma.promptVersion.findMany({
        where: { promptId },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          promptId: true,
          versionNumber: true,
          variables: true,
          modelId: true,
          createdBy: true,
          createdAt: true,
          model: { select: { publicName: true } },
        },
      }),
      prisma.promptVersion.count({ where: { promptId } }),
    ]);

    return { rows, total };
  }

  /**
   * Fetches a version by UUID together with its parent prompt's id and name,
   * scoped to a team via the prompt's `teamId`. Returns null if not found or
   * cross-team.
   *
   * @param id - UUID of the prompt_versions row.
   * @param teamId - The calling team's UUID (isolation boundary).
   * @returns The row plus `{ prompt: { id, name } }`, or null.
   */
  async findByIdWithPromptForTeam(
    id: string,
    teamId: string,
  ): Promise<
    | (PromptVersionRow & {
        prompt: { id: string; name: string };
        model: { publicName: string } | null;
      })
    | null
  > {
    return prisma.promptVersion.findFirst({
      where: { id, prompt: { teamId, deletedAt: null } },
      include: {
        prompt: { select: { id: true, name: true } },
        model: { select: { publicName: true } },
      },
    });
  }
}
