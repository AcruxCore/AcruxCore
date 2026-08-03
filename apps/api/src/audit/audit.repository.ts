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
