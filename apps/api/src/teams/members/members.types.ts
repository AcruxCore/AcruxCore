import { z } from 'zod';
import type { team_role } from '@prisma/client';

/** Shape of a member as returned by GET /teams/:id/members. */
export interface MemberListItem {
  userId:   string;
  email:    string;
  role:     team_role;
  joinedAt: string;
}

/**
 * Zod schema for the body of PATCH /teams/:id/members/:userId/roles.
 * The path stays plural for backwards compatibility — only the body changed
 * from `{ roles: [...] }` to `{ role }` when members became single-role.
 * Owner cannot be granted via this endpoint.
 */
export const UpdateRoleSchema = z.object({
  role: z.enum(['admin', 'editor', 'viewer'], {
    errorMap: () => ({ message: 'role must be one of admin, editor, viewer' }),
  }),
});

export type UpdateRoleDto = z.infer<typeof UpdateRoleSchema>;
