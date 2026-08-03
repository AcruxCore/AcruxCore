import { z } from 'zod';
import type { team_role } from '@prisma/client';

/** Shape of a pending invite as returned by GET /teams/:id/invites. */
export interface InviteListItem {
  id:        string;
  token:     string;
  role:      team_role;
  invitedBy: string;
  /** Address the invite was emailed to, or null for a copy-link invite. */
  email:     string | null;
  expiresAt: string;
  createdAt: string;
}

/**
 * Zod schema for POST /teams/:id/invites.
 * The owner role cannot be granted via invite — only admin/editor/viewer.
 * `email` is optional: when present the invite is emailed, when absent the
 * caller copies the link, which is the behaviour that existed before.
 */
export const CreateInviteSchema = z.object({
  role: z.enum(['admin', 'editor', 'viewer'], {
    errorMap: () => ({ message: 'role must be one of admin, editor, viewer' }),
  }),
  // Trimmed and lowercased BEFORE the `.email()` format check (so
  // "  Foo@Example.COM  " validates instead of being rejected for its
  // whitespace) and again at the boundary here rather than relying on the web
  // client, which already trims — the API is the actual boundary. Without
  // this, `Foo@Example.COM` and `foo@example.com` would land as two distinct
  // values in `team_invites.email` and `email_log.to_email`.
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').optional(),
});

export type CreateInviteDto = z.infer<typeof CreateInviteSchema>;

/**
 * Zod schema for POST /teams/invites/:token/accept.
 * No body needed — the token identifies the invite.
 */
export const AcceptInviteSchema = z.object({});
export type AcceptInviteDto = z.infer<typeof AcceptInviteSchema>;
