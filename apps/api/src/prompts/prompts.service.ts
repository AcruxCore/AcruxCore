import { PromptsRepository } from './prompts.repository';
import {
  CreatePromptDto,
  UpdatePromptDto,
  ListPromptsQuery,
  PromptResponseDto,
  PromptListResponseDto,
} from './prompts.types';
import { audit } from '../shared/audit';
import { ConflictError, NotFoundError } from '../shared/errors';
import prisma from '../shared/db/client';
import { runInTransaction } from '../shared/db/unit-of-work';
import { Prisma, Prompt } from '@prisma/client';

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
   * Rejects a name that another ACTIVE prompt in the team already holds.
   *
   * The name is how an app reaches a prompt — render by name, the SDK's `render()`
   * and the gateway's stored-prompt path all resolve it. Two active prompts sharing
   * one would let an app render a different prompt from the one just edited.
   * Soft-deleted prompts are excluded, so deleting a prompt frees its name.
   *
   * Callers must hold {@link PromptsRepository.lockName} for the same name in `tx`.
   *
   * @param name - The name being claimed.
   * @param teamId - Isolation boundary.
   * @param tx - Transaction the lock and the subsequent write share.
   * @param exceptPromptId - Prompt allowed to keep the name, for a no-op rename.
   * @throws {ConflictError} PROMPT_NAME_TAKEN if an active prompt already holds it.
   */
  private async assertNameFree(
    name: string,
    teamId: string,
    tx: Prisma.TransactionClient,
    exceptPromptId?: string,
  ): Promise<void> {
    const existing = await this.repo.findByName(name, teamId, tx);
    if (existing && existing.id !== exceptPromptId) {
      throw new ConflictError('PROMPT_NAME_TAKEN', `A prompt named '${name}' already exists in this team.`);
    }
  }

  /**
   * Creates a new prompt shell (no content yet — content is added in B3).
   * Emits a `prompt_created` audit event.
   *
   * @param userId - The creating user's ID (written to createdBy and audit).
   * @param teamId - The active team's ID.
   * @param dto - Validated body: name (required), description (optional).
   * @throws {ConflictError} PROMPT_NAME_TAKEN if an active prompt in the team holds the name.
   */
  async create(
    userId: string,
    teamId: string,
    dto: CreatePromptDto,
  ): Promise<PromptResponseDto> {
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
   * @throws {ConflictError} PROMPT_NAME_TAKEN if renaming onto another active prompt's name.
   */
  async update(
    id: string,
    teamId: string,
    actorId: string,
    dto: UpdatePromptDto,
  ): Promise<PromptResponseDto> {
    const existing = await this.repo.findById(id, teamId);
    if (!existing) throw new NotFoundError('Prompt not found.');

    const updated = await runInTransaction(async (tx) => {
      // A rename claims a name the same way a create does. A PATCH that keeps the
      // name (the Settings dialog always sends it) claims nothing, so it skips the
      // lock — and must, or the newer of two pre-uniqueness duplicates could never save.
      if (dto.name !== undefined && dto.name !== existing.name) {
        await this.repo.lockName(teamId, dto.name, tx);
        await this.assertNameFree(dto.name, teamId, tx, id);
      }
      return this.repo.update(
        id,
        teamId,
        {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.description !== undefined && { description: dto.description }),
        },
        tx,
      );
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
