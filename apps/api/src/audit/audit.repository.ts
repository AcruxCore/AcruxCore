import prisma from '../shared/db/client';
import type { AuditLogEntry } from './audit.types';

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
   * @param teamId - UUID of the team; enforces tenant scope.
   * @param page    - 1-indexed page number.
   * @param limit   - Number of records per page (max 100).
   * @returns Object with `rows` (current page entries) and `total` (full count).
   */
  async listForTeam(
    teamId: string,
    page: number,
    limit: number,
  ): Promise<{ rows: AuditLogEntry[]; total: number }> {
    const offset = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where: { teamId },
        include: { actor: { select: { id: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.auditLog.count({ where: { teamId } }),
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
}
