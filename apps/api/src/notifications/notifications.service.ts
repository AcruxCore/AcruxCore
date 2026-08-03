import { NotificationsRepository } from './notifications.repository';
import {
  NOTIFICATION_CATEGORIES,
  type EffectivePreferences,
  type NotificationCategory,
  type UpdatePreferenceDto,
} from './notifications.types';

/**
 * Read/write access to a user's notification preferences for one team.
 */
export class NotificationsService {
  constructor(private readonly repo: NotificationsRepository) {}

  /**
   * Returns the effective preference for every category.
   *
   * Categories with no stored row resolve to `true`: absence means enabled, which
   * is what lets a new category ship without a backfill migration. So this always
   * returns a complete map, never a partial one the caller has to default.
   *
   * @param teamId - Team scope.
   * @param userId - The user whose preferences to read.
   * @returns Every category mapped to its effective boolean.
   */
  async get(teamId: string, userId: string): Promise<EffectivePreferences> {
    const rows = await this.repo.listForUser(teamId, userId);
    const stored = new Map(rows.map((r) => [r.category, r.enabled]));

    const result = {} as EffectivePreferences;
    for (const category of NOTIFICATION_CATEGORIES) {
      result[category] = stored.get(category) ?? true;
    }
    return result;
  }

  /**
   * Sets one category for one user in one team, then returns the full effective
   * map so a client never has to merge the response into its own state.
   *
   * @param teamId - Team scope.
   * @param userId - The user whose preference to set.
   * @param dto - Validated category + enabled.
   * @returns The effective preferences after the write.
   */
  async update(
    teamId: string,
    userId: string,
    dto: UpdatePreferenceDto,
  ): Promise<EffectivePreferences> {
    await this.repo.upsert(teamId, userId, dto.category, dto.enabled);
    return this.get(teamId, userId);
  }

  /**
   * Turns a category off on behalf of an unsubscribe token.
   *
   * Separate from {@link update} because the caller is unauthenticated: the token
   * is the only evidence of identity, so this method never takes an `enabled`
   * flag (a token can only ever unsubscribe, never re-subscribe) and it verifies
   * the membership still exists before writing.
   *
   * Idempotent — unsubscribing twice leaves exactly one row, via the
   * `(user, team, category)` unique key.
   *
   * @param teamId - Team from the verified token.
   * @param userId - User from the verified token.
   * @param category - Category from the verified token.
   * @returns true when a preference row was written; false when the user is no
   *   longer a member of that team and there is nothing meaningful to store.
   */
  async unsubscribe(
    teamId: string,
    userId: string,
    category: NotificationCategory,
  ): Promise<boolean> {
    if (!(await this.repo.isStillMember(teamId, userId))) return false;
    await this.repo.upsert(teamId, userId, category, false);
    return true;
  }
}
