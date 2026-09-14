import { Prisma, Tool } from '@prisma/client';
import prisma from '../shared/db/client';
import type { ToolReadinessDto } from './tools.types';

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
   * Readiness for a batch of tools: version count, latest version, alias targets, and
   * the executor `production` serves.
   *
   * Three queries for any number of tools, never one per tool. The naive shape — fetch
   * a tool's versions and aliases to decide whether it is callable — is why no list
   * screen showed it, and a list of 25 tools issuing 50 requests to say "yes, callable"
   * is not a trade worth making.
   *
   * `executorType` reads only the `production` alias's version, so a tool with two hundred
   * versions and a dozen aliases still loads exactly one executor.
   *
   * All three queries are scoped to `teamId` through the `Tool` relation rather than trusting
   * the caller to have already filtered `toolIds` to one team: a future caller that takes
   * ids straight from a request body must not be able to read another team's readiness by
   * guessing or enumerating tool ids. The same relation filter excludes soft-deleted
   * tools, matching {@link findById}, {@link findByName} and {@link list} — without it a
   * deleted tool still reported its version count and alias targets to such a caller.
   *
   * @param toolIds - Tools to describe. An empty list returns an empty map.
   * @param teamId - Isolation boundary. An id in `toolIds` that belongs to another team
   *   (or does not exist) matches neither query and so has no entry in the returned map —
   *   callers read it with {@link toToolResponseDto}'s default parameter, which treats a
   *   missing entry the same as {@link NOT_CALLABLE}.
   * @returns Readiness keyed by tool id, present only for ids this team actually owns.
   *   A team-owned tool with no committed version has no entry either — the caller's
   *   {@link NOT_CALLABLE} default reads the same either way.
   */
  async readinessFor(toolIds: string[], teamId: string): Promise<Map<string, ToolReadinessDto>> {
    const out = new Map<string, ToolReadinessDto>();
    if (toolIds.length === 0) return out;

    const scope = { toolId: { in: toolIds }, tool: { teamId, deletedAt: null } };
    const [counts, aliasRows, productionRows] = await Promise.all([
      prisma.toolVersion.groupBy({
        by: ['toolId'],
        where: scope,
        _count: { _all: true },
        _max: { versionNumber: true },
      }),
      // Every alias, for the `aliases` list — version numbers only. The executor is
      // deliberately not selected here: it is a JSON blob that can carry three JS
      // transform sources, and only `production`'s is ever read. Selecting it per alias
      // meant a 100-tool page pulled one blob per alias to use at most one in a hundred.
      prisma.toolAlias.findMany({
        where: scope,
        select: { toolId: true, alias: true, version: { select: { versionNumber: true } } },
      }),
      // `production` alone, for `executorType`. At most one row per tool.
      prisma.toolAlias.findMany({
        where: { ...scope, alias: 'production' },
        select: { toolId: true, version: { select: { executor: true } } },
      }),
    ]);

    const executorByTool = new Map(productionRows.map((r) => [r.toolId, r.version.executor]));

    const byTool = new Map<string, typeof aliasRows>();
    for (const row of aliasRows) {
      const list = byTool.get(row.toolId) ?? [];
      list.push(row);
      byTool.set(row.toolId, list);
    }

    // Only ids the scoped queries returned rows for are entered — see the JSDoc for why.
    const knownIds = new Set<string>([...counts.map((c) => c.toolId), ...byTool.keys()]);
    const countByTool = new Map(counts.map((c) => [c.toolId, c]));

    for (const id of toolIds) {
      if (!knownIds.has(id)) continue;
      const count = countByTool.get(id);
      const rows = byTool.get(id) ?? [];
      // `production` first: it is the alias every unqualified reference resolves to,
      // so it is the one a reader is looking for.
      const sorted = [...rows].sort((a, b) =>
        a.alias === 'production' ? -1 : b.alias === 'production' ? 1 : a.alias.localeCompare(b.alias),
      );
      const production = rows.find((r) => r.alias === 'production');
      const executor = executorByTool.get(id) as { type?: 'client' | 'http' } | null | undefined;
      out.set(id, {
        callable: production !== undefined,
        versionCount: count?._count._all ?? 0,
        latestVersionNumber: count?._max.versionNumber ?? null,
        executorType: executor?.type ?? null,
        aliases: sorted.map((r) => ({ alias: r.alias, versionNumber: r.version.versionNumber })),
      });
    }
    return out;
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
