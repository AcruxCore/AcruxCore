import type { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import type { PromptVersionRow, CreateVersionInput } from './versions.types';

/**
 * Data-access class for the prompt_versions table.
 * All queries for prompt versions go through this class — no other file imports prisma for this table.
 */
export class VersionsRepository {
  /**
   * Inserts a new prompt_versions row numbered MAX(version_number) + 1 (1 for
   * the first version).
   *
   * The prompt row is locked for the transaction, so concurrent commits to one
   * prompt run one after another and each reads the number the previous one
   * wrote. Without the lock they all read the same MAX, and every insert but
   * one failed the (prompt_id, version_number) unique index with a 500 (#742).
   * Commits to different prompts do not wait for each other. NO KEY UPDATE rather
   * than UPDATE: it still makes commits wait for each other, but not for the
   * FOR KEY SHARE lock that inserting any row referencing the prompt takes (a
   * candidate, an alias, a tool binding), and those inserts do not wait for it.
   *
   * @param data - All fields of the version except its number.
   * @param tx - Runs on this transaction instead of a new one, so a caller that
   *   holds a lock of its own inserts on the connection it already has.
   * @returns The newly inserted row.
   */
  async createNext(data: CreateVersionInput, tx?: Prisma.TransactionClient): Promise<PromptVersionRow> {
    return tx ? this.insertNext(data, tx) : prisma.$transaction((own) => this.insertNext(data, own));
  }

  /** The lock, the MAX and the insert of {@link createNext}, on one transaction. */
  private async insertNext(data: CreateVersionInput, tx: Prisma.TransactionClient): Promise<PromptVersionRow> {
    await tx.$queryRaw`SELECT id FROM prompts WHERE id = ${data.promptId}::uuid FOR NO KEY UPDATE`;
    const result = await tx.promptVersion.aggregate({
      where: { promptId: data.promptId },
      _max: { versionNumber: true },
    });
    return tx.promptVersion.create({
      data: {
        promptId: data.promptId,
        versionNumber: (result._max.versionNumber ?? 0) + 1,
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
   * Counts how many of the given version ids belong to this team.
   *
   * For a caller holding a list of ids from a request body: compare the result
   * with the number of distinct ids supplied and reject the whole list when they
   * differ. One query rather than one per id, which matters because an
   * experiment may name up to 50 versions in a single create.
   *
   * @param ids - Version UUIDs to test. Duplicates are ignored by the IN clause,
   *        so the caller compares against its own DISTINCT count.
   * @param teamId - The calling team's UUID (isolation boundary).
   * @returns How many distinct ids are versions of a prompt owned by this team.
   */
  async countByIdsForTeam(ids: string[], teamId: string): Promise<number> {
    return prisma.promptVersion.count({
      where: { id: { in: ids }, prompt: { teamId } },
    });
  }

  /**
   * Fetches the most recently committed version for a prompt, team-scoped —
   * the fallback baseline when no alias is specified (design
   * "Alias-based baseline"). Independent of any alias.
   *
   * @param promptId - UUID of the parent prompt.
   * @param teamId - The calling team's UUID (isolation boundary).
   * @returns The highest-`versionNumber` row, or null if the prompt has no committed versions.
   */
  async findLatestForPrompt(promptId: string, teamId: string): Promise<PromptVersionRow | null> {
    return prisma.promptVersion.findFirst({
      where: { promptId, prompt: { teamId } },
      orderBy: { versionNumber: 'desc' },
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
