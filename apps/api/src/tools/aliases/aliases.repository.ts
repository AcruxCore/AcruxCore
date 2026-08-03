import type { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import { AliasDetail } from './aliases.types';

/**
 * Data-access class for the tool_aliases table.
 * All queries for tool aliases go through this class — no other file imports
 * prisma for this table.
 */
export class ToolAliasesRepository {
  /**
   * Inserts 'production' and 'staging' alias rows both pointing to the given version.
   * Called exactly once per tool — when the first version is committed.
   *
   * @param toolId - UUID of the parent tool.
   * @param versionId - UUID of the first tool_versions row.
   * @param tx - Optional transaction client, so `POST /tools/sync` can create a tool,
   *   its first version and both aliases in one transaction.
   * @returns Array of two AliasDetail objects (production, staging).
   */
  async autoCreateAliases(toolId: string, versionId: string, tx?: Prisma.TransactionClient): Promise<AliasDetail[]> {
    const db = tx ?? prisma;
    const versionRow = await db.toolVersion.findUnique({
      where: { id: versionId },
      select: { versionNumber: true },
    });
    const versionNumber = versionRow?.versionNumber ?? 1;
    const now = new Date();
    // Two sequential creates rather than `prisma.$transaction([...])`: when `tx` is
    // supplied we are ALREADY inside a transaction and Prisma cannot nest one, so the
    // array form would throw. Atomicity is then the outer transaction's job; when no
    // `tx` is given these are the first two rows a fresh tool gets, so a partial write
    // would need the process to die between two adjacent statements.
    const production = await db.toolAlias.create({
      data: { toolId, alias: 'production', versionId, updatedAt: now },
    });
    const staging = await db.toolAlias.create({
      data: { toolId, alias: 'staging', versionId, updatedAt: now },
    });
    return [production, staging].map((r) => ({
      id: r.id,
      alias: r.alias,
      versionId: r.versionId,
      versionNumber,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * Finds a single alias by (tool_id, alias) with its target version number.
   *
   * @param toolId - UUID of the parent tool.
   * @param alias - The alias name (e.g. 'production').
   * @param tx - Optional transaction client, so a caller inside a transaction reads the
   *   alias as that transaction sees it.
   * @returns The alias with its target versionNumber, or undefined if not found.
   */
  async findByAlias(toolId: string, alias: string, tx?: Prisma.TransactionClient): Promise<AliasDetail | undefined> {
    const row = await (tx ?? prisma).toolAlias.findUnique({
      where: { uq_tool_aliases_tool_alias: { toolId, alias } },
      include: { version: { select: { versionNumber: true } } },
    });
    if (!row) return undefined;
    return {
      id: row.id,
      alias: row.alias,
      versionId: row.versionId,
      versionNumber: row.version.versionNumber,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Lists all aliases for a tool with their target version numbers.
   *
   * @param toolId - UUID of the parent tool.
   * @returns Array of alias details, joined with version number, ordered by alias name.
   */
  async listByTool(toolId: string): Promise<AliasDetail[]> {
    const rows = await prisma.toolAlias.findMany({
      where: { toolId },
      include: { version: { select: { versionNumber: true } } },
      orderBy: { alias: 'asc' },
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
   * Upserts an alias row — inserts if the (tool_id, alias) doesn't exist,
   * updates version_id and updated_at if it does. Implements both promotion
   * (forward) and rollback (backward).
   *
   * @param toolId - UUID of the parent tool.
   * @param alias - The alias name.
   * @param versionId - UUID of the target tool_versions row.
   * @param tx - Optional transaction client, so `POST /tools/sync` can commit a version
   *   and move the alias to it atomically.
   * @returns The upserted alias with its version number.
   * @throws {Error} If versionId does not correspond to an existing tool_versions row.
   */
  async upsertAlias(
    toolId: string,
    alias: string,
    versionId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<AliasDetail> {
    const db = tx ?? prisma;
    const versionRow = await db.toolVersion.findUnique({
      where: { id: versionId },
      select: { versionNumber: true },
    });
    if (!versionRow) throw new Error(`Version row not found for versionId: ${versionId}`);
    const row = await db.toolAlias.upsert({
      where: { uq_tool_aliases_tool_alias: { toolId, alias } },
      create: { toolId, alias, versionId, updatedAt: new Date() },
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
