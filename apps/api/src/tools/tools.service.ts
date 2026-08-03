import type { Prisma } from '@prisma/client';
import { ToolsRepository } from './tools.repository';
import {
  CreateToolDto,
  UpdateToolDto,
  ListToolsQuery,
  ToolResponseDto,
  ToolListResponseDto,
  toToolResponseDto,
} from './tools.types';
import { audit } from '../shared/audit';
import { ConflictError, NotFoundError } from '../shared/errors';
import prisma from '../shared/db/client';
import { runInTransaction } from '../shared/db/unit-of-work';

/**
 * Business logic for the Tool shell domain (create/list/get/update/soft-delete).
 * Orchestrates repository calls and emits audit events.
 * Throws typed errors; never returns HTTP status codes.
 *
 * Note: `tool_created` is reused (with an `updated: true` metadata flag) for
 * update events rather than adding a `tool_updated` enum member — this keeps
 * the Phase 4 migration surface minimal. A distinct event can be added later
 * in its own migration if needed. There is no dedicated delete audit event
 * (the `AuditEvent` enum has no `tool_deleted` member yet), so `remove` does
 * not emit an audit entry.
 */
export class ToolsService {
  constructor(private readonly repo: ToolsRepository) {}

  /**
   * Rejects a name that another ACTIVE tool in the team already holds.
   *
   * A tool name is not decoration: `POST /tools/sync` and every `tool_ref` find a
   * tool by it, and `findByName` returns the first match with no ordering. Two
   * active tools sharing a name therefore make resolution arbitrary — a deploy and
   * a dashboard edit can silently end up on different rows. Soft-deleted tools are
   * excluded, so deleting a tool frees its name for reuse.
   *
   * Callers must hold {@link ToolsRepository.lockName} for the same name in `tx`;
   * without it this check is a read that another transaction can invalidate before
   * the insert lands.
   *
   * @param name - The name being claimed.
   * @param teamId - Isolation boundary.
   * @param tx - Transaction the lock and the subsequent write share.
   * @param exceptToolId - Tool allowed to keep the name, for a no-op rename.
   * @throws {ConflictError} TOOL_NAME_TAKEN if an active tool already holds it.
   */
  private async assertNameFree(
    name: string,
    teamId: string,
    tx: Prisma.TransactionClient,
    exceptToolId?: string,
  ): Promise<void> {
    const existing = await this.repo.findByName(name, teamId, tx);
    if (existing && existing.id !== exceptToolId) {
      throw new ConflictError('TOOL_NAME_TAKEN', `A tool named '${name}' already exists in this team.`);
    }
  }

  /**
   * Creates a new tool shell (no versions/aliases yet — those are added in
   * later TC1 tasks). Emits a `tool_created` audit event.
   *
   * @param userId - The creating user's ID (written to createdBy and audit).
   * @param teamId - The active team's ID.
   * @param dto - Validated body: name (required, provider-safe pattern), description (optional).
   * @throws {ConflictError} TOOL_NAME_TAKEN if an active tool in the team already
   *   holds this name — names are how `tool_ref`s and `POST /tools/sync` resolve.
   */
  async create(userId: string, teamId: string, dto: CreateToolDto): Promise<ToolResponseDto> {
    const row = await runInTransaction(async (tx) => {
      await this.repo.lockName(teamId, dto.name, tx);
      await this.assertNameFree(dto.name, teamId, tx);
      return this.repo.create(
        {
          name: dto.name,
          description: dto.description,
          teamId,
          createdBy: userId,
        },
        tx,
      );
    });

    void audit(prisma, {
      teamId,
      actorId: userId,
      event: 'tool_created',
      metadata: { toolId: row.id, name: row.name },
    });

    return toToolResponseDto(row);
  }

  /**
   * Returns a paginated list of active tools for the team.
   * Soft-deleted tools are excluded.
   *
   * @param teamId - Scopes the list to this team.
   * @param query - Validated query params: search, page, limit.
   */
  async list(teamId: string, query: ListToolsQuery): Promise<ToolListResponseDto> {
    const { rows, total } = await this.repo.list({
      teamId,
      search: query.search,
      page: query.page,
      limit: query.limit,
    });

    return {
      data: rows.map(toToolResponseDto),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Fetches a single active tool by ID.
   *
   * @param id - Tool UUID.
   * @param teamId - Isolation boundary: throws if the tool belongs to another team.
   * @throws {NotFoundError} If the tool is not found, deleted, or belongs to another team.
   */
  async getById(id: string, teamId: string): Promise<ToolResponseDto> {
    const row = await this.repo.findById(id, teamId);
    if (!row) throw new NotFoundError('Tool not found.');
    return toToolResponseDto(row);
  }

  /**
   * Partially updates a tool's name and/or description.
   * Emits a `tool_created` audit event with an `updated: true` metadata flag
   * (see class-level note on why there's no dedicated `tool_updated` event).
   *
   * @param id - Tool UUID.
   * @param teamId - Isolation boundary.
   * @param userId - User performing the update (for audit).
   * @param dto - Validated partial update body.
   * @throws {NotFoundError} If the tool is not found or belongs to another team.
   * @throws {ConflictError} TOOL_NAME_TAKEN if renaming onto another active tool's name.
   */
  async update(id: string, teamId: string, userId: string, dto: UpdateToolDto): Promise<ToolResponseDto> {
    const row = await runInTransaction(async (tx) => {
      // A rename claims a name the same way a create does, so it takes the same lock
      // and the same check. Only a rename needs it — a description-only PATCH cannot
      // collide with anything.
      if (dto.name !== undefined) {
        await this.repo.lockName(teamId, dto.name, tx);
        await this.assertNameFree(dto.name, teamId, tx, id);
      }
      return this.repo.update(id, teamId, { name: dto.name, description: dto.description }, tx);
    });
    if (!row) throw new NotFoundError('Tool not found.');

    void audit(prisma, {
      teamId,
      actorId: userId,
      event: 'tool_created',
      metadata: { toolId: id, updated: true },
    });

    return toToolResponseDto(row);
  }

  /**
   * Soft-deletes a tool by setting `deleted_at = now()`.
   * Version and alias rows are preserved in the DB.
   *
   * @param id - Tool UUID.
   * @param teamId - Isolation boundary.
   * @throws {NotFoundError} If the tool is not found, already deleted, or belongs to another team.
   */
  async remove(id: string, teamId: string): Promise<void> {
    const ok = await this.repo.softDelete(id, teamId);
    if (!ok) throw new NotFoundError('Tool not found.');
  }
}
