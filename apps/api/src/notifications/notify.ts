import { EmailRepository, EmailService, appLink } from '../email';
// Imported from the token file rather than `../email/unsubscribe`'s barrel: that
// barrel also exports the router, which imports this domain back.
import { mintUnsubscribeToken } from '../email/unsubscribe/unsubscribe.token';
import { MembersRepository } from '../teams/members/members.repository';
import { NotificationsRepository } from './notifications.repository';
import type {
  NotificationCategory,
  NotifyAudience,
  NotifyInput,
  NotifyRecipient,
} from './notifications.types';

// Module-level singletons. `notify()` is a free function by design — the whole
// point of the seam is that a call site adds one line without wiring a
// dependency graph — so its collaborators are constructed once here rather than
// injected. All three are stateless.
const members = new MembersRepository();
const prefs = new NotificationsRepository();
const emails = new EmailService(new EmailRepository());

/**
 * Builds the absolute one-click unsubscribe URL for one recipient and category.
 *
 * @param userId - Recipient.
 * @param teamId - Team the preference belongs to.
 * @param category - Category being turned off.
 * @returns An absolute `/api/v1/email/unsubscribe?token=…` URL.
 */
export function unsubscribeLink(
  userId: string,
  teamId: string,
  category: NotificationCategory,
): string {
  const token = mintUnsubscribeToken({ userId, teamId, category });
  return appLink(`/api/v1/email/unsubscribe?token=${encodeURIComponent(token)}`);
}

/**
 * A coarse time bucket for events that have no natural idempotency key.
 *
 * A membership change is identified by nothing durable — `updateRoles` and
 * `remove` create no row to name — so a dedupe key must include *something*
 * time-varying or a later, legitimate change to the same member would collide
 * with the earlier one and be silently dropped (BullMQ keeps completed job ids
 * around, per `removeOnComplete`). A one-minute bucket is the compromise: a
 * double-clicked button lands in the same bucket and sends one email, while a
 * real second change minutes later gets its own.
 *
 * @returns Whole minutes since the epoch.
 */
export function eventBucket(): number {
  return Math.floor(Date.now() / 60_000);
}

/**
 * Resolves an audience descriptor to a deduplicated recipient list.
 *
 * @param teamId - Team scope for the role lookup.
 * @param audience - Explicit users and/or roles, plus an optional fallback.
 * @returns One entry per distinct user, in no guaranteed order.
 */
export async function resolveAudience(
  teamId: string,
  audience: NotifyAudience,
): Promise<NotifyRecipient[]> {
  const byId = new Map<string, NotifyRecipient>();

  const collect = (rows: NotifyRecipient[]): void => {
    for (const r of rows) if (!byId.has(r.userId)) byId.set(r.userId, r);
  };

  if (audience.userIds?.length) {
    collect(await members.findEmailsByUserIds(audience.userIds));
  }
  if (audience.roles?.length) {
    collect(await members.findEmailsByRoles(teamId, audience.roles));
  }

  // Only when the primary audience is genuinely empty — a run whose starter is
  // unknown, a team whose only admin was just deleted. Without this an event
  // would notify nobody and leave no trace of having tried.
  if (byId.size === 0 && audience.fallbackRoles?.length) {
    collect(await members.findEmailsByRoles(teamId, audience.fallbackRoles));
  }

  return [...byId.values()];
}

/**
 * Resolves recipients, filters by preference, and enqueues one email per
 * surviving recipient.
 *
 * **Never throws.** A notification failure must not roll back or fail the
 * business operation that triggered it: `MembersService.remove` must succeed
 * even when SES is down or Redis is unreachable. Failures are logged, and any
 * send that got as far as a job lands in `email_log` with status `failed`. This
 * mirrors how the existing `audit()` helper is called after a successful
 * operation rather than inside its transaction.
 *
 * Each recipient's job id is `<dedupeKey>:<userId>`, so two concurrent
 * detections of the same event (two gateway requests crossing 80% at once)
 * collapse to one email *per person* — deduping on the event alone would mean
 * only whichever recipient was enqueued first ever heard about it.
 *
 * @param input - Event category, team, audience, template key, props, dedupe key.
 * @returns The number of emails enqueued. Zero is a normal outcome (everyone
 *   opted out, or the audience is empty), not an error.
 */
export async function notify(input: NotifyInput): Promise<number> {
  try {
    const recipients = await resolveAudience(input.teamId, input.audience);
    if (recipients.length === 0) return 0;

    const skip = input.ignorePreferences
      ? new Set<string>()
      : await prefs.findOptedOutUserIds(
          input.teamId,
          input.category,
          recipients.map((r) => r.userId),
        );

    let enqueued = 0;
    for (const recipient of recipients) {
      if (skip.has(recipient.userId)) continue;

      try {
        const id = await emails.enqueue({
          teamId: input.teamId,
          to: recipient.email,
          dedupeKey: `${input.dedupeKey}:${recipient.userId}`,
          payload: {
            ...input.payload,
            props: {
              ...input.payload.props,
              unsubscribeUrl: unsubscribeLink(
                recipient.userId,
                input.teamId,
                input.category,
              ),
            },
          } as Parameters<EmailService['enqueue']>[0]['payload'],
        });
        if (id) enqueued++;
      } catch (err) {
        // One unreachable recipient must not cost the others their email, so
        // this is caught per recipient rather than only around the whole loop.
        console.error(
          `[notify] failed to enqueue ${input.payload.type} for user ${recipient.userId}`,
          err,
        );
      }
    }

    return enqueued;
  } catch (err) {
    console.error(`[notify] failed to send ${input.payload.type} notification`, err);
    return 0;
  }
}
