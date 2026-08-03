import { PromptsRepository } from './prompts.repository';
import {
  CreatePromptDto,
  UpdatePromptDto,
  ListPromptsQuery,
  PromptResponseDto,
  PromptListResponseDto,
} from './prompts.types';
import { audit } from '../shared/audit';
import { NotFoundError } from '../shared/errors';
import prisma from '../shared/db/client';
import { Prompt } from '@prisma/client';

/** Maps a DB row to the DTO shape returned by the API. */
function toResponseDto(row: Prompt): PromptResponseDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    teamId: row.teamId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/**
 * Business logic for the prompts domain.
 * Orchestrates repository calls and emits audit events.
 * Throws typed errors; never returns HTTP status codes.
 */
export class PromptsService {
  constructor(private readonly repo: PromptsRepository) {}

  /**
   * Creates a new prompt shell (no content yet — content is added in B3).
   * Emits a `prompt_created` audit event.
   *
   * @param userId - The creating user's ID (written to createdBy and audit).
   * @param teamId - The active team's ID.
   * @param dto - Validated body: name (required), description (optional).
   */
  async create(
    userId: string,
    teamId: string,
    dto: CreatePromptDto,
  ): Promise<PromptResponseDto> {
    const row = await this.repo.create({
      name: dto.name,
      description: dto.description,
      teamId,
      createdBy: userId,
    });

    await audit(prisma, {
      teamId,
      actorId: userId,
      event: 'prompt_created',
      promptId: row.id,
      metadata: { name: row.name },
    });

    return toResponseDto(row);
  }

  /**
   * Returns a paginated list of active prompts for the team.
   * Soft-deleted prompts are excluded.
   *
   * @param teamId - Scopes the list to this team.
   * @param query - Validated query params: search, page, limit.
   */
  async list(teamId: string, query: ListPromptsQuery): Promise<PromptListResponseDto> {
    const { rows, total } = await this.repo.list({
      teamId,
      search: query.search,
      page: query.page,
      limit: query.limit,
    });

    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        createdAt: r.createdAt,
      })),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Fetches a single active prompt by ID.
   * Returns the same shape as create/update.
   *
   * @param id - Prompt UUID.
   * @param teamId - Isolation boundary: returns 404 if the prompt belongs to another team.
   * @throws {NotFoundError} If the prompt is not found, deleted, or belongs to another team.
   */
  async getById(id: string, teamId: string): Promise<PromptResponseDto> {
    const row = await this.repo.findById(id, teamId);
    if (!row) throw new NotFoundError('Prompt not found.');
    return toResponseDto(row);
  }

  /**
   * Partially updates a prompt's name and/or description.
   * Emits `prompt_renamed` when the name changes, `prompt_updated` when only description changes.
   *
   * @param id - Prompt UUID.
   * @param teamId - Isolation boundary.
   * @param actorId - User performing the update (for audit).
   * @param dto - Validated partial update body.
   * @throws {NotFoundError} If the prompt is not found or belongs to another team.
   */
  async update(
    id: string,
    teamId: string,
    actorId: string,
    dto: UpdatePromptDto,
  ): Promise<PromptResponseDto> {
    const existing = await this.repo.findById(id, teamId);
    if (!existing) throw new NotFoundError('Prompt not found.');

    const updated = await this.repo.update(id, teamId, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.description !== undefined && { description: dto.description }),
    });

    if (!updated) throw new NotFoundError('Prompt not found.');

    if (dto.name !== undefined && dto.name !== existing.name) {
      await audit(prisma, {
        teamId,
        actorId,
        event: 'prompt_renamed',
        promptId: id,
        metadata: { old_name: existing.name, new_name: dto.name },
      });
    } else if (dto.description !== undefined) {
      await audit(prisma, {
        teamId,
        actorId,
        event: 'prompt_updated',
        promptId: id,
        metadata: { field: 'description' },
      });
    }

    return toResponseDto(updated);
  }

  /**
   * Soft-deletes a prompt by setting `deleted_at = now()`.
   * Version and alias rows are preserved in the DB.
   * Emits a `prompt_deleted` audit event.
   *
   * @param id - Prompt UUID.
   * @param teamId - Isolation boundary.
   * @param actorId - User performing the delete (for audit).
   * @throws {NotFoundError} If the prompt is not found, already deleted, or belongs to another team.
   */
  async delete(id: string, teamId: string, actorId: string): Promise<void> {
    const deleted = await this.repo.softDelete(id, teamId);
    if (!deleted) throw new NotFoundError('Prompt not found.');

    await audit(prisma, {
      teamId,
      actorId,
      event: 'prompt_deleted',
      promptId: id,
      metadata: { name: deleted.name },
    });
  }
}
