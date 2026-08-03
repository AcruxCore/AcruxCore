import { Prompt } from '@prisma/client';
import prisma from '../shared/db/client';

/** Parameters for creating a new prompt. */
interface CreateParams {
  name: string;
  description?: string;
  teamId: string;
  createdBy: string;
}

/** Parameters for listing prompts with optional search + pagination. */
interface ListParams {
  teamId: string;
  search?: string;
  page: number;
  limit: number;
}

/** Return type for list(): rows for the current page + total count. */
interface ListResult {
  rows: Prompt[];
  total: number;
}

/** Fields that may be updated via PATCH. */
interface UpdateFields {
  name?: string;
  description?: string | null;
}

/**
 * Data access layer for the prompts domain.
 * All queries that touch the `prompts` table live here.
 * Services must never import `prisma` directly.
 */
export class PromptsRepository {
  /**
   * Inserts a new prompt row and returns the created row.
   *
   * @param params - Name, optional description, team_id, created_by.
   * @returns The newly inserted prompt.
   */
  async create(params: CreateParams): Promise<Prompt> {
    return prisma.prompt.create({
      data: {
        name: params.name,
        description: params.description ?? null,
        teamId: params.teamId,
        createdBy: params.createdBy,
      },
    });
  }

  /**
   * Finds an active (non-deleted) prompt by id scoped to a team.
   * Returns undefined if not found, soft-deleted, or belongs to a different team.
   *
   * @param id - Prompt UUID.
   * @param teamId - The calling user's active team UUID (isolation boundary).
   */
  async findById(id: string, teamId: string): Promise<Prompt | undefined> {
    const row = await prisma.prompt.findFirst({
      where: { id, teamId, deletedAt: null },
    });
    return row ?? undefined;
  }

  /**
   * Returns a paginated list of active prompts for a team, optionally filtered
   * by a case-insensitive search against name and description.
   * Results are ordered newest-first.
   *
   * @param params - teamId, optional search string, page (1-indexed), limit.
   * @returns `{ rows, total }` — `total` is the full count (for pagination controls).
   */
  async list(params: ListParams): Promise<ListResult> {
    const { teamId, search, page, limit } = params;
    const offset = (page - 1) * limit;

    const where = {
      teamId,
      deletedAt: null,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { description: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.prompt.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.prompt.count({ where }),
    ]);

    return { rows, total };
  }

  /**
   * Partially updates a prompt's name and/or description.
   * Returns the updated row, or undefined if the prompt doesn't exist or is deleted.
   *
   * @param id - Prompt UUID.
   * @param teamId - Isolation boundary — only updates prompts in this team.
   * @param fields - The fields to update; only provided fields are changed.
   */
  async update(
    id: string,
    teamId: string,
    fields: UpdateFields,
  ): Promise<Prompt | undefined> {
    const result = await prisma.prompt.updateMany({
      where: { id, teamId, deletedAt: null },
      data: fields,
    });
    if (result.count === 0) return undefined;
    const row = await prisma.prompt.findUnique({ where: { id } });
    return row ?? undefined;
  }

  /**
   * Soft-deletes a prompt by setting `deleted_at = now()`.
   * Does not touch versions or aliases — history is preserved.
   * Returns the updated row (with deletedAt set), or undefined if not found.
   *
   * @param id - Prompt UUID.
   * @param teamId - Isolation boundary.
   */
  async softDelete(id: string, teamId: string): Promise<Prompt | undefined> {
    const result = await prisma.prompt.updateMany({
      where: { id, teamId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) return undefined;
    const row = await prisma.prompt.findUnique({ where: { id } });
    return row ?? undefined;
  }
}
