import { Prisma } from '@prisma/client';
import type { SavedView } from '@prisma/client';
import { ViewsRepository } from './views.repository';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import type { CreateViewDto, SavedViewDto, UpdateViewDto, ViewSurface } from './views.types';

/** Postgres unique-violation code, as Prisma surfaces it. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * Business logic for saved views: a named filter set on the trace or feedback
 * list.
 *
 * Any team member may create, rename and delete a view. Per-user ownership was
 * considered and rejected — a view is a shared way of looking at the team's own
 * traffic, and "you cannot delete Ali's view" costs more in a small team than an
 * accidental deletion does.
 */
export class ViewsService {
  constructor(private readonly repo: ViewsRepository) {}

  /** Maps a row to the API DTO (timestamps → ISO strings). */
  private toDto(row: SavedView): SavedViewDto {
    return {
      id: row.id,
      surface: row.surface,
      name: row.name,
      query: row.query,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Lists a team's saved views for one surface.
   *
   * @param teamId - Isolation boundary.
   * @param surface - `traces` or `feedback`.
   */
  async list(teamId: string, surface: ViewSurface): Promise<SavedViewDto[]> {
    const rows = await this.repo.list(teamId, surface);
    return rows.map((r) => this.toDto(r));
  }

  /**
   * Creates a saved view.
   *
   * @param teamId - Owning team.
   * @param userId - The caller's user id, or null for a team-scoped API key.
   * @param dto - Validated surface, name and query string.
   * @returns The created view.
   * @throws {ConflictError} If the team already has a view with this name on this surface.
   */
  async create(teamId: string, userId: string | null, dto: CreateViewDto): Promise<SavedViewDto> {
    try {
      const row = await this.repo.create(teamId, userId, dto);
      return this.toDto(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
        throw new ConflictError('VIEW_NAME_TAKEN', 'A view with that name already exists.');
      }
      throw err;
    }
  }

  /**
   * Renames a view and/or re-points it at a different filter set.
   *
   * @param teamId - Isolation boundary.
   * @param id - View id.
   * @param dto - Validated partial update; at least one field must be present.
   * @returns The updated view.
   * @throws {ValidationError} If the body changes nothing.
   * @throws {NotFoundError} If the view does not exist in this team.
   * @throws {ConflictError} If the new name is already taken on this surface.
   */
  async update(teamId: string, id: string, dto: UpdateViewDto): Promise<SavedViewDto> {
    if (dto.name === undefined && dto.query === undefined) {
      throw new ValidationError('Provide a name or a query to update.');
    }

    const existing = await this.repo.findById(teamId, id);
    if (!existing) throw new NotFoundError('View not found.');

    try {
      const row = await this.repo.update(id, dto);
      return this.toDto(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
        throw new ConflictError('VIEW_NAME_TAKEN', 'A view with that name already exists.');
      }
      throw err;
    }
  }

  /**
   * Deletes a view.
   *
   * @param teamId - Isolation boundary.
   * @param id - View id.
   * @throws {NotFoundError} If the view does not exist in this team.
   */
  async delete(teamId: string, id: string): Promise<void> {
    const existing = await this.repo.findById(teamId, id);
    if (!existing) throw new NotFoundError('View not found.');
    await this.repo.delete(id);
  }
}
