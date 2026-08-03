import { Prisma, Tool } from '@prisma/client';
import prisma from '../shared/db/client';

/** Parameters for creating a new tool shell. */
interface CreateParams {
  name: string;
  description?: string;
  teamId: string;
  createdBy: string;
}

/** Parameters for listing tools with optional search + pagination. */
interface ListParams {
  teamId: string;
  search?: string;
  page: number;
  limit: number;
}

/** Return type for list(): rows for the current page + total count. */
interface ListResult {
  rows: Tool[];
  total: number;
}

/** Fields that may be updated via PATCH. */
interface UpdateFields {
  name?: string;
  description?: string | null;
}

/**
 * Advisory-lock namespace for tool-name serialisation. Arbitrary, but must not be
 * reused by another advisory lock in this codebase — the pair
 * `(namespace, hashtext(key))` is what Postgres actually locks on.
 */
const TOOL_NAME_LOCK_NAMESPACE = 4271;

/**
 * Data access layer for the tools domain (the mutable shell only —
 * versions/aliases have their own repositories, added in later TC1 tasks).
 * All queries that touch the `tools` table live here.
 * Services must never import `prisma` directly.
 */
export class ToolsRepository {
  /**
   * Serialises every writer that could claim the tool name `(teamId, name)`, for the
   * remainder of the calling transaction.
   *
   * Postgres has nothing to lock here: the row a caller is about to create does not
   * exist yet, so `SELECT ... FOR UPDATE` has nothing to take. A transaction-scoped
   * advisory lock gives the name itself a lock, which is what makes
   * find-then-create safe. Two concurrent `POST /tools/sync` calls would otherwise
   * both see "no such tool" and both create one, leaving two active tools sharing a
   * name and `findByName` picking between them arbitrarily.
   *
   * The lock covers the version-number race too: while it is held, no other writer
   * can be inside `computeNextVersionNumber` → `create` for the same tool, so the
   * `MAX(version_number) + 1` two callers compute cannot collide.
   *
   * Released automatically when the transaction commits or rolls back — there is no
   * unlock call and no leak if the caller throws.
   *
   * @param teamId - Owning team; part of the key, so two teams never block each other.
   * @param name - The tool name being claimed.
   * @param tx - The transaction to scope the lock to. Required: a lock taken outside
   *   a transaction would be released immediately and protect nothing.
   */
  async lockName(teamId: string, name: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TOOL_NAME_LOCK_NAMESPACE}::int, hashtext(${`${teamId}:${name}`}))`;
  }

  /**
   * Inserts a new tool row and returns the created row.
   *
   * @param params - Name, optional description, team_id, created_by.
   * @param tx - Optional transaction client, so `POST /tools/sync` can create the
   *   shell, its first version and its aliases atomically.
   * @returns The newly inserted tool.
   */
  async create(params: CreateParams, tx?: Prisma.TransactionClient): Promise<Tool> {
    return (tx ?? prisma).tool.create({
      data: {
        name: params.name,
        description: params.description ?? null,
        teamId: params.teamId,
        createdBy: params.createdBy,
      },
    });
  }

  /**
   * Finds an active (non-deleted) tool by id scoped to a team.
   * Returns undefined if not found, soft-deleted, or belongs to a different team.
   *
   * @param id - Tool UUID.
   * @param teamId - The calling user's active team UUID (isolation boundary).
   */
  async findById(id: string, teamId: string): Promise<Tool | undefined> {
    const row = await prisma.tool.findFirst({
      where: { id, teamId, deletedAt: null },
    });
    return row ?? undefined;
  }

  /**
   * Finds an active (non-deleted) tool by name scoped to a team.
   * Used by the gateway's `tool_refs` resolver (TC2) to look up tools by name.
   *
   * @param name - Tool name (the function name the LLM sees).
   * @param teamId - The calling user's active team UUID (isolation boundary).
   * @param tx - Optional transaction client, so `POST /tools/sync` can look the tool
   *   up inside the transaction that may go on to create it.
   */
  async findByName(name: string, teamId: string, tx?: Prisma.TransactionClient): Promise<Tool | undefined> {
    const row = await (tx ?? prisma).tool.findFirst({
      where: { name, teamId, deletedAt: null },
    });
    return row ?? undefined;
  }

  /**
   * Sets a tool's shell-level description, used by `POST /tools/sync` to keep the
   * catalog's summary matching the decorated function's docstring.
   *
   * Separate from {@link update}: that one backs the PATCH endpoint and re-checks the
   * team, whereas this is called inside a transaction by a caller that has already
   * verified it.
   *
   * @param id - Tool UUID, already team-verified by the caller.
   * @param description - The new description, or null to clear it.
   * @param tx - Optional transaction client.
   */
  async setDescription(id: string, description: string | null, tx?: Prisma.TransactionClient): Promise<void> {
    await (tx ?? prisma).tool.update({ where: { id }, data: { description } });
  }

  /**
   * Returns a paginated list of active tools for a team, optionally filtered
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
      prisma.tool.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.tool.count({ where }),
    ]);

    return { rows, total };
  }

  /**
   * Partially updates a tool's name and/or description.
   * Returns the updated row, or undefined if the tool doesn't exist or is deleted.
   *
   * @param id - Tool UUID.
   * @param teamId - Isolation boundary — only updates tools in this team.
   * @param fields - The fields to update; only provided fields are changed.
   * @param tx - Optional transaction client, so a rename can share the transaction
   *   that holds the name lock and the uniqueness check.
   */
  async update(
    id: string,
    teamId: string,
    fields: UpdateFields,
    tx?: Prisma.TransactionClient,
  ): Promise<Tool | undefined> {
    const db = tx ?? prisma;
    const result = await db.tool.updateMany({
      where: { id, teamId, deletedAt: null },
      data: fields,
    });
    if (result.count === 0) return undefined;
    const row = await db.tool.findUnique({ where: { id } });
    return row ?? undefined;
  }

  /**
   * Soft-deletes a tool by setting `deleted_at = now()`.
   * Does not touch versions or aliases — history is preserved.
   *
   * @param id - Tool UUID.
   * @param teamId - Isolation boundary.
   * @returns `true` if a row was updated, `false` if not found/already deleted/cross-team.
   */
  async softDelete(id: string, teamId: string): Promise<boolean> {
    const result = await prisma.tool.updateMany({
      where: { id, teamId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return result.count > 0;
  }
}
