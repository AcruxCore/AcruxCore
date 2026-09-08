import prisma from '../../shared/db/client';
import type { SavedView } from '@prisma/client';

/**
 * Data access for `saved_views`. The only file in this domain that touches
 * Prisma. Every query is team-scoped, so a view id from another team resolves to
 * null and the service turns that into a 404.
 */
export class ViewsRepository {
  /**
   * Lists a team's saved views for one surface, alphabetically — a named view is
   * looked up by name, so alphabetical beats newest-first here.
   *
   * @param teamId - Isolation boundary.
   * @param surface - `traces` or `feedback`.
   */
  async list(teamId: string, surface: string): Promise<SavedView[]> {
    return prisma.savedView.findMany({
      where: { teamId, surface },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Inserts one view.
   *
   * @param teamId - Owning team.
   * @param createdBy - The caller's user id, or null for a team-scoped API key.
   * @param input - Surface, name and the raw query string.
   * @returns The created row.
   * @throws Prisma unique-constraint error when the team already has a view with
   *   this name on this surface; the service maps it to a 409.
   */
  async create(
    teamId: string,
    createdBy: string | null,
    input: { surface: string; name: string; query: string },
  ): Promise<SavedView> {
    return prisma.savedView.create({
      data: { teamId, createdBy, ...input },
    });
  }

  /**
   * Reads one view within a team.
   *
   * @param teamId - Isolation boundary.
   * @param id - View id.
   * @returns The row, or null when it does not exist in this team.
   */
  async findById(teamId: string, id: string): Promise<SavedView | null> {
    return prisma.savedView.findFirst({ where: { id, teamId } });
  }

  /**
   * Updates a view's name and/or query.
   *
   * @param id - View id, already confirmed to belong to the team.
   * @param patch - The fields to change.
   * @returns The updated row.
   */
  async update(id: string, patch: { name?: string; query?: string }): Promise<SavedView> {
    return prisma.savedView.update({ where: { id }, data: patch });
  }

  /**
   * Deletes a view.
   *
   * @param id - View id, already confirmed to belong to the team.
   */
  async delete(id: string): Promise<void> {
    await prisma.savedView.delete({ where: { id } });
  }
}
