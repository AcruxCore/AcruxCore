import { z } from 'zod';
import { AuditEvent } from '@prisma/client';

/**
 * Zod schema for pagination query parameters on the audit log endpoint.
 * Defaults: page=1, limit=20. Max limit is capped at 100.
 */
export const AuditQuerySchema = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type AuditQuery = z.infer<typeof AuditQuerySchema>;

/**
 * Upper bound on how many event names one request may filter by. The enum has
 * 34 members, so a list longer than this is a malformed or hostile query rather
 * than a real filter.
 */
const MAX_EVENT_FILTER = 40;

/**
 * Zod schema for the team-wide audit endpoint: pagination plus the two optional
 * filters the dashboard needs to make a 1,000-row trail readable.
 *
 * `event` arrives as a comma-separated list (`?event=api_key_revoked,member_removed`)
 * rather than a repeated param, because the UI groups the 34 enum values into
 * categories and a category expands to several names — one short param carries a
 * whole group. Unknown names are rejected with a 400 instead of silently ignored,
 * so a typo in a saved link is visible rather than returning the unfiltered list.
 */
export const TeamAuditQuerySchema = AuditQuerySchema.extend({
  event: z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined) return undefined;
      const names = Array.from(new Set(raw.split(',').map(s => s.trim()).filter(Boolean)));
      return names.length > 0 ? names : undefined;
    })
    .pipe(z.array(z.nativeEnum(AuditEvent)).max(MAX_EVENT_FILTER).optional()),
  actorId: z.string().uuid('actorId must be a UUID.').optional(),
});

export type TeamAuditQuery = z.infer<typeof TeamAuditQuerySchema>;

/**
 * Optional narrowing applied to a team-wide audit read. Both fields are AND-ed:
 * an `events` list of one or more enum values, and a single `actorId`.
 */
export interface TeamAuditFilters {
  events?:  AuditEvent[];
  actorId?: string;
}

/**
 * One distinct actor who has written at least one audit event for the team,
 * with how many they wrote. Feeds the dashboard's actor filter, which must list
 * people who have since been removed from the team — their events remain in the
 * trail and are exactly what a compliance question asks about.
 */
export interface AuditActor {
  id:         string;
  email:      string;
  eventCount: number;
}

/** Response envelope for the audit-actors endpoint. Unpaginated: one row per person. */
export interface AuditActorsResponse {
  data: AuditActor[];
}

/**
 * A single audit log entry returned to the client.
 * Includes actor email resolved from the users join.
 */
export interface AuditLogEntry {
  id:        string;
  event:     string;
  actor:     { id: string; email: string };
  metadata:  Record<string, unknown> | null;
  createdAt: string;
  /** The prompt this event relates to, or null for a team-wide (non-prompt) event. */
  promptId:  string | null;
  /**
   * The person this event was performed *on*, resolved from
   * `metadata.targetUserId` — set on `member_role_updated` and `member_removed`,
   * absent everywhere else.
   *
   * Only the team-wide endpoint populates this. It exists because the stored
   * metadata holds a raw user id, and "who was removed on Tuesday" cannot be
   * answered by a screen that can only print a UUID. Resolved from `users`, not
   * from current membership, so a removed member still shows their address.
   */
  target?:   { id: string; email: string } | null;
}

/**
 * Paginated audit log response envelope.
 */
export interface AuditListResponse {
  data:  AuditLogEntry[];
  total: number;
  page:  number;
  limit: number;
}
