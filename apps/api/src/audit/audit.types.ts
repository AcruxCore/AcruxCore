import { z } from 'zod';

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
