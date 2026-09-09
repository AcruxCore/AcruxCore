import type { Prisma } from '@prisma/client';
import prisma from '../shared/db/client';
import type { AuditActor, AuditLogEntry, TeamAuditFilters } from './audit.types';

/**
 * Repository for reading the audit_log table.
 * All queries are scoped to a team_id for tenant isolation.
 */
export class AuditRepository {
  /**
   * Checks whether a prompt exists and belongs to the given team.
   *
   * @param promptId - UUID of the prompt.
   * @param teamId   - UUID of the team; ensures cross-tenant isolation.
   * @returns The prompt row if found, or undefined.
   */
  async findPrompt(
    promptId: string,
    teamId: string,
  ): Promise<{ id: string } | undefined> {
    const prompt = await prisma.prompt.findFirst({
      where: { id: promptId, teamId, deletedAt: null },
      select: { id: true },
    });
    return prompt ?? undefined;
  }

  /**
   * Returns a paginated list of audit log entries for a specific prompt,
   * ordered newest first, joined with the actor's email from the users table.
   *
   * @param promptId - UUID of the prompt whose audit events to fetch.
   * @param teamId   - UUID of the team; enforces tenant scope.
   * @param page     - 1-indexed page number.
   * @param limit    - Number of records per page (max 100).
   * @returns Object with `rows` (current page entries) and `total` (full count).
   */
  async listForPrompt(
    promptId: string,
    teamId: string,
    page: number,
    limit: number,
  ): Promise<{ rows: AuditLogEntry[]; total: number }> {
    const offset = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where: { promptId, teamId },
        include: { actor: { select: { id: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.auditLog.count({ where: { promptId, teamId } }),
    ]);

    const entries: AuditLogEntry[] = rows.map(r => ({
      id:        r.id,
      event:     r.event,
      actor:     { id: r.actor.id, email: r.actor.email },
      metadata:  r.metadata as Record<string, unknown> | null,
      createdAt: r.createdAt.toISOString(),
      promptId:  r.promptId,
    }));

    return { rows: entries, total };
  }

  /**
   * Checks whether a tool exists and belongs to the given team.
   *
   * @param toolId - UUID of the tool.
   * @param teamId - UUID of the team; ensures cross-tenant isolation.
   * @returns The tool row if found, or undefined.
   */
  async findTool(
    toolId: string,
    teamId: string,
  ): Promise<{ id: string } | undefined> {
    const tool = await prisma.tool.findFirst({
      where: { id: toolId, teamId, deletedAt: null },
      select: { id: true },
    });
    return tool ?? undefined;
  }

  /**
   * Returns a paginated list of audit log entries for a specific tool, ordered
   * newest first. Tool events (`tool_created`, `tool_version_committed`,
   * `tool_alias_promoted`, `tool_version_superseded`) carry `toolId` inside
   * `metadata` rather than a dedicated column — `audit_log` has no `tool_id`
   * FK — so this filters on the JSON payload instead of a relation.
   *
   * @param toolId - UUID of the tool whose audit events to fetch.
   * @param teamId - UUID of the team; enforces tenant scope.
   * @param page   - 1-indexed page number.
   * @param limit  - Number of records per page (max 100).
   * @returns Object with `rows` (current page entries) and `total` (full count).
   */
  async listForTool(
    toolId: string,
    teamId: string,
    page: number,
    limit: number,
  ): Promise<{ rows: AuditLogEntry[]; total: number }> {
    const offset = (page - 1) * limit;
    const where = { teamId, metadata: { path: ['toolId'], equals: toolId } } as const;

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { actor: { select: { id: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.auditLog.count({ where }),
    ]);

    const entries: AuditLogEntry[] = rows.map(r => ({
      id:        r.id,
      event:     r.event,
      actor:     { id: r.actor.id, email: r.actor.email },
      metadata:  r.metadata as Record<string, unknown> | null,
      createdAt: r.createdAt.toISOString(),
      promptId:  r.promptId,
    }));

    return { rows: entries, total };
  }

  /**
   * Returns a paginated list of every audit log entry for a team (Finding
   * #13), ordered newest first — not scoped to any single prompt, unlike
   * `listForPrompt`. Uses the same `idx_audit_log_team` index.
   *
   * @param teamId  - UUID of the team; enforces tenant scope.
   * @param page    - 1-indexed page number.
   * @param limit   - Number of records per page (max 100).
   * @param filters - Optional `events` / `actorId` narrowing, AND-ed together.
   * @returns Object with `rows` (current page entries) and `total` (count after filtering).
   */
  async listForTeam(
    teamId: string,
    page: number,
    limit: number,
    filters: TeamAuditFilters = {},
  ): Promise<{ rows: AuditLogEntry[]; total: number }> {
    const offset = (page - 1) * limit;
    const where = teamAuditWhere(teamId, filters);

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { actor: { select: { id: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.auditLog.count({ where }),
    ]);

    const targets = await this.resolveTargets(rows.map(r => r.metadata));

    const entries: AuditLogEntry[] = rows.map(r => ({
      id:        r.id,
      event:     r.event,
      actor:     { id: r.actor.id, email: r.actor.email },
      metadata:  r.metadata as Record<string, unknown> | null,
      createdAt: r.createdAt.toISOString(),
      promptId:  r.promptId,
      target:    targets.get(targetUserId(r.metadata) ?? '') ?? null,
    }));

    return { rows: entries, total };
  }

  /**
   * Resolves the `metadata.targetUserId` on a page of rows to `{ id, email }`,
   * in one query rather than per row. Reads `users` directly, so a member who
   * has since been removed from the team still resolves.
   *
   * @param metadatas - The `metadata` column of every row on the page.
   * @returns A map from user id to identity; empty when no row carries a target.
   */
  private async resolveTargets(
    metadatas: unknown[],
  ): Promise<Map<string, { id: string; email: string }>> {
    const ids = Array.from(
      new Set(metadatas.map(targetUserId).filter((v): v is string => v !== null)),
    );
    if (ids.length === 0) return new Map();

    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true },
    });
    return new Map(users.map(u => [u.id, u]));
  }

  /**
   * Returns every distinct actor who has written an audit event for the team,
   * with their event count, ordered by email.
   *
   * Deliberately built from `audit_log` rather than the team's current
   * membership: a removed member's events stay in the trail, and "who did this"
   * is the question a compliance reviewer asks about people who have left.
   *
   * @param teamId - UUID of the team; enforces tenant scope.
   * @returns One row per actor, ascending by email.
   */
  async listTeamActors(teamId: string): Promise<AuditActor[]> {
    const grouped = await prisma.auditLog.groupBy({
      by: ['actorId'],
      where: { teamId },
      _count: { _all: true },
    });
    if (grouped.length === 0) return [];

    const users = await prisma.user.findMany({
      where: { id: { in: grouped.map(g => g.actorId) } },
      select: { id: true, email: true },
    });
    const emailById = new Map(users.map(u => [u.id, u.email]));

    return grouped
      .map(g => ({
        id:         g.actorId,
        email:      emailById.get(g.actorId) ?? 'unknown',
        eventCount: g._count._all,
      }))
      .sort((a, b) => a.email.localeCompare(b.email));
  }
}

/**
 * Builds the `where` clause shared by the team-wide list and its count, so the
 * two can never drift and report a `total` that does not match the rows.
 *
 * @param teamId  - UUID of the team; always present, it is the isolation boundary.
 * @param filters - Optional `events` / `actorId` narrowing.
 * @returns A Prisma filter for `audit_log`.
 */
function teamAuditWhere(teamId: string, filters: TeamAuditFilters): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = { teamId };
  if (filters.events && filters.events.length > 0) where.event = { in: filters.events };
  if (filters.actorId) where.actorId = filters.actorId;
  return where;
}

/**
 * Pulls a UUID-shaped `targetUserId` out of an audit row's metadata, or null.
 * Shape-checked rather than trusted: `metadata` is free-form JSON, and a
 * non-UUID value passed into a Prisma `uuid` filter would throw.
 *
 * @param metadata - The row's `metadata` column, of unknown shape.
 * @returns The target user id, or null when absent or malformed.
 */
function targetUserId(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const value = (metadata as Record<string, unknown>).targetUserId;
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

/** Canonical UUID form, used to keep a malformed metadata value out of a Prisma filter. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
