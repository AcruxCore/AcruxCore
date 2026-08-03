import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import { CreateToolVersionInput, ToolVersionRow } from './versions.types';

/**
 * Data-access class for the tool_versions table.
 * All queries for tool versions go through this class — no other file imports
 * prisma for this table. Team-scoping is enforced by the caller (service) via
 * the parent tool relation, not here.
 */
export class ToolVersionsRepository {
  /**
   * Computes the next sequential version_number for a tool.
   * Uses MAX(version_number) + 1, returning 1 for the first version.
   *
   * @param toolId - UUID of the tool.
   * @returns The next version number to use (1-based).
   */
  async computeNextVersionNumber(toolId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const result = await (tx ?? prisma).toolVersion.aggregate({
      where: { toolId },
      _max: { versionNumber: true },
    });
    return (result._max.versionNumber ?? 0) + 1;
  }

  /**
   * Inserts a new tool_versions row (immutable once created).
   *
   * @param input - All fields required to create the version.
   * @param tx - Optional transaction client. `POST /tools/sync` creates the tool,
   *   the version and the alias move in one transaction, so it must be able to
   *   hand its own client in rather than committing each step separately.
   * @returns The newly inserted row.
   */
  async create(input: CreateToolVersionInput, tx?: Prisma.TransactionClient): Promise<ToolVersionRow> {
    return (tx ?? prisma).toolVersion.create({
      data: {
        toolId: input.toolId,
        versionNumber: input.versionNumber,
        description: input.description ?? null,
        changelog: input.changelog ?? null,
        source: input.source,
        parametersSchema: input.parametersSchema as Prisma.InputJsonValue,
        executor: input.executor as unknown as Prisma.InputJsonValue,
        createdBy: input.createdBy,
      },
    });
  }

  /**
   * Fetches a version by its (tool_id, version_number) composite lookup.
   * Returns null if the version does not exist for this tool.
   *
   * @param toolId - UUID of the parent tool.
   * @param versionNumber - The 1-based sequential version number.
   * @param tx - Optional transaction client, so `POST /tools/sync` can read the
   *   currently-live version inside the same transaction that may supersede it.
   * @returns The row, or null if not found.
   */
  async findByVersionNumber(
    toolId: string,
    versionNumber: number,
    tx?: Prisma.TransactionClient,
  ): Promise<ToolVersionRow | null> {
    return (tx ?? prisma).toolVersion.findUnique({
      where: { uq_tool_versions_tool_version: { toolId, versionNumber } },
    });
  }

  /**
   * Fetches a version by its primary key UUID.
   *
   * This performs a GLOBAL lookup with no team scoping — it must only be used
   * by callers that have already resolved the id through a team-scoped path.
   * Consumed by TC3's pinned-attachment resolution.
   *
   * @param id - UUID of the tool_versions row.
   * @returns The row, or null if not found.
   */
  async findById(id: string): Promise<ToolVersionRow | null> {
    return prisma.toolVersion.findUnique({ where: { id } });
  }

  /**
   * Lists versions for a tool, newest first, with offset-based pagination.
   * parametersSchema/executor are excluded to keep payloads small — use
   * findByVersionNumber for full content.
   *
   * @param toolId - UUID of the parent tool.
   * @param page - 1-based page number.
   * @param limit - Items per page (max 100).
   * @returns Paginated rows (without parametersSchema/executor) and total count.
   */
  async listByTool(
    toolId: string,
    page: number,
    limit: number,
  ): Promise<{ rows: Omit<ToolVersionRow, 'parametersSchema' | 'executor'>[]; total: number }> {
    const offset = (page - 1) * limit;
    const [rows, total] = await Promise.all([
      prisma.toolVersion.findMany({
        where: { toolId },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          toolId: true,
          versionNumber: true,
          description: true,
          changelog: true,
          source: true,
          createdBy: true,
          createdAt: true,
        },
      }),
      prisma.toolVersion.count({ where: { toolId } }),
    ]);
    return { rows, total };
  }
}
