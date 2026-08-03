import { z } from 'zod';
import type { team_role } from '@prisma/client';
import type { EmailPayload } from '../email';

/**
 * Coarse notification categories. Three cover every event in spec B plus the
 * weekly digest — deliberately not one per email type, because per-type control
 * is a preference UI nobody has asked for.
 *
 * `budget_alerts` covers the 80% warning and the exhausted notice; `membership`
 * covers joined, removed, and roles-changed.
 */
export const NOTIFICATION_CATEGORIES = [
  'budget_alerts',
  'eval_runs',
  'membership',
  'weekly_digest',
] as const;

/** One of {@link NOTIFICATION_CATEGORIES}. */
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Runtime guard for a category arriving from a URL or request body. */
export const NotificationCategorySchema = z.enum(NOTIFICATION_CATEGORIES);

/** Body of `PATCH /api/v1/notifications/preferences`. */
export const UpdatePreferenceSchema = z.object({
  category: NotificationCategorySchema,
  enabled: z.boolean(),
});
export type UpdatePreferenceDto = z.infer<typeof UpdatePreferenceSchema>;

/**
 * The effective preference set for one user in one team: every category with a
 * resolved boolean, whether or not a row exists.
 */
export type EffectivePreferences = Record<NotificationCategory, boolean>;

/** A resolved recipient: who to mail and what to call them. */
export interface NotifyRecipient {
  userId: string;
  email: string;
  /** Display name, falling back to the email when none is set. */
  name: string;
}

/**
 * How to find an event's audience. Not every event has the same one, and none of
 * them is "everyone on the team".
 *
 * `userIds` and `roles` are unioned (deduplicated by user id); `fallbackRoles`
 * is consulted only when that union is empty, which is what keeps a run with a
 * null `createdBy` from silently notifying nobody.
 */
export interface NotifyAudience {
  /**
   * Explicit users, resolved straight from `users` rather than through team
   * membership — `member_removed` must still reach someone whose membership row
   * was just deleted.
   */
  userIds?: string[];
  /** Every current member of the team holding any of these roles. */
  roles?: team_role[];
  /** Consulted only when `userIds` + `roles` yield nobody. */
  fallbackRoles?: team_role[];
}

/**
 * An {@link EmailPayload} with the per-recipient `unsubscribeUrl` removed.
 *
 * `notify()` mints one unsubscribe token per recipient, so a caller supplies
 * everything *except* that field and cannot accidentally send one recipient
 * another's token. Written as a distributive conditional type so the union stays
 * in one place: adding a notification template automatically updates this.
 */
export type NotifyPayload = EmailPayload extends infer T
  ? T extends { type: infer K; props: infer P }
    ? K extends 'team_invite'
      ? never // an invite is requested one-at-a-time, not a preference-gated notification
      : { type: K; props: Omit<P, 'unsubscribeUrl'> }
    : never
  : never;

/** Everything `notify()` needs to fan one event out to its audience. */
export interface NotifyInput {
  /** Team the event happened in. Scopes both the audience and the preference. */
  teamId: string;
  /** Preference category gating this send. */
  category: NotificationCategory;
  /** Who should hear about it. */
  audience: NotifyAudience;
  /** Template key + props, minus `unsubscribeUrl`. */
  payload: NotifyPayload;
  /**
   * Deterministic idempotency key for the *event*, e.g.
   * `budget:<budgetId>:<periodStart>:80`. `notify()` appends each recipient's
   * user id, so two concurrent detections of the same event collapse to one
   * email per person rather than one email in total.
   */
  dedupeKey: string;
  /**
   * Skip the preference filter. Set **only** for `member_removed`: losing access
   * to a team is account-security-adjacent, and the preference row recording the
   * opt-out is itself about to become unreachable.
   */
  ignorePreferences?: boolean;
}
