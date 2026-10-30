import { Prisma, Prompt } from '@prisma/client';
import prisma from '../shared/db/client';
import { LockNamespace, lockTeamName } from '../shared/db/advisory-lock';

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
   * Serialises every writer that claims the same `(teamId, name)`, so a
   * check-then-insert cannot interleave with another one.
   *
   * Without it, two concurrent `POST /prompts` with one name both see "no such
   * prompt" and both insert. A partial unique index would do this in the database,
   * but Prisma's schema cannot express `WHERE deleted_at IS NULL`, so a later
   * `prisma migrate dev` would drop it (same reasoning as tools, phase-4-faq Q47).
   *
   * Released automatically when the transaction commits or rolls back.
   *
   * @param teamId - Owning team; part of the key, so two teams never block each other.
   * @param name - The prompt name being claimed.
   * @param tx - The transaction to scope the lock to. Required: a lock taken outside
   *   a transaction would be released immediately and protect nothing.
   */
  async lockName(teamId: string, name: string, tx: Prisma.TransactionClient): Promise<void> {
    await lockTeamName(tx, LockNamespace.PromptName, teamId, name);
  }

  /**
   * Inserts a new prompt row and returns the created row.
   *
   * @param params - Name, optional description, team_id, created_by.
   * @param tx - Optional transaction client, so the insert shares the name lock.
   * @returns The newly inserted prompt.
   */
  async create(params: CreateParams, tx?: Prisma.TransactionClient): Promise<Prompt> {
    return (tx ?? prisma).prompt.create({
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
   * Finds an active (non-deleted) prompt by its exact name within a team — the
   * key an app uses, since apps ask for prompts by name rather than by id.
   *
   * Names are unique among active prompts now, but a team created before that can
   * still hold two. The oldest wins, so every by-name lookup agrees on one prompt
   * instead of taking whichever row Postgres returns first.
   *
   * @param name - The prompt's exact name.
   * @param teamId - Isolation boundary.
   * @param tx - Optional transaction client, for a check made under {@link lockName}.
   * @returns The prompt, or undefined if the team has none by that name.
   */
  async findByName(name: string, teamId: string, tx?: Prisma.TransactionClient): Promise<Prompt | undefined> {
    const row = await (tx ?? prisma).prompt.findFirst({
      where: { name, teamId, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return row ?? undefined;
  }

  /**
   * Loads what an online evaluation rule needs to grade with its custom judge
   * prompt, in one call: the `production` alias's messages and the latest
   * version's messages, so the caller can prefer the first.
   *
   * Deliberately does NOT filter on `deletedAt`. Prompt delete is a soft
   * delete, so a rule keeps its `judge_prompt_id` after the prompt is deleted,
   * and such rules have always kept grading. Offline runs use the stricter
   * `findById` and refuse a deleted prompt at run start instead.
   *
   * @param id - Prompt UUID (the rule's `judge_prompt_id`).
   * @param teamId - Isolation boundary. Another team's prompt returns null.
   * @returns The prompt name and the two candidate message sets (each null when
   *   absent), or null if the prompt does not exist in this team.
   */
  async findJudgeTemplateForTeam(
    id: string,
    teamId: string,
  ): Promise<{ name: string; productionMessages: unknown | null; latestMessages: unknown | null } | null> {
    const row = await prisma.prompt.findFirst({
      where: { id, teamId },
      select: {
        name: true,
        aliases: { where: { alias: 'production' }, select: { version: { select: { messages: true } } } },
        versions: { orderBy: { versionNumber: 'desc' }, take: 1, select: { messages: true } },
      },
    });
    if (!row) return null;
    return {
      name: row.name,
      productionMessages: row.aliases[0]?.version.messages ?? null,
      latestMessages: row.versions[0]?.messages ?? null,
    };
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
   * @param tx - Optional transaction client, so a rename shares the name lock.
   */
  async update(
    id: string,
    teamId: string,
    fields: UpdateFields,
    tx?: Prisma.TransactionClient,
  ): Promise<Prompt | undefined> {
    const db = tx ?? prisma;
    const result = await db.prompt.updateMany({
      where: { id, teamId, deletedAt: null },
      data: fields,
    });
    if (result.count === 0) return undefined;
    const row = await db.prompt.findUnique({ where: { id } });
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
