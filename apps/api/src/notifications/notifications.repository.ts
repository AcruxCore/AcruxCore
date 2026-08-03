import prisma from '../shared/db/client';
import type { NotificationCategory } from './notifications.types';

/**
 * All database access for `notification_preferences`.
 *
 * Only ever reads rows to find opt-*outs*: no row means enabled, so nothing is
 * written at signup and adding a category needs no backfill.
 */
export class NotificationsRepository {
  /**
   * Returns the user ids, of those supplied, that have opted out of a category
   * in this team.
   *
   * Takes the candidate list rather than returning every opt-out row in the
   * team, so the query stays bounded by the size of the audience.
   *
   * @param teamId - Team scope.
   * @param category - Category being sent.
   * @param userIds - Candidate recipients. An empty array short-circuits.
   * @returns The subset that must be skipped.
   */
  async findOptedOutUserIds(
    teamId: string,
    category: NotificationCategory,
    userIds: string[],
  ): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();

    const rows = await prisma.notificationPreference.findMany({
      where: { teamId, category, enabled: false, userId: { in: userIds } },
      select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  }

  /**
   * Returns every stored preference row for one user in one team.
   *
   * Rows are the exceptions, not the whole picture — the service layer fills in
   * the enabled default for categories with no row.
   *
   * @param teamId - Team scope.
   * @param userId - The user.
   * @returns Stored `(category, enabled)` pairs.
   */
  async listForUser(
    teamId: string,
    userId: string,
  ): Promise<{ category: string; enabled: boolean }[]> {
    return prisma.notificationPreference.findMany({
      where: { teamId, userId },
      select: { category: true, enabled: true },
    });
  }

  /**
   * Sets one preference, creating the row if it does not exist.
   *
   * Upserts on the `(user_id, team_id, category)` unique key, which is what makes
   * unsubscribing twice a no-op rather than a second row.
   *
   * @param teamId - Team scope.
   * @param userId - The user.
   * @param category - Category to set.
   * @param enabled - New value.
   */
  async upsert(
    teamId: string,
    userId: string,
    category: NotificationCategory,
    enabled: boolean,
  ): Promise<void> {
    await prisma.notificationPreference.upsert({
      where: { userId_teamId_category: { userId, teamId, category } },
      create: { userId, teamId, category, enabled },
      update: { enabled },
    });
  }

  /**
   * Confirms a user is a member of a team.
   *
   * Used by the unauthenticated unsubscribe endpoint: a signed token proves who
   * minted it, but writing a preference row for a `(user, team)` pair that no
   * longer exists would leave an FK-valid but meaningless row behind after the
   * user was removed from the team.
   *
   * @param teamId - Team from the token.
   * @param userId - User from the token.
   * @returns true when the membership row still exists.
   */
  async isStillMember(teamId: string, userId: string): Promise<boolean> {
    const row = await prisma.teamMember.findFirst({
      where: { teamId, userId },
      select: { id: true },
    });
    return row !== null;
  }
}
