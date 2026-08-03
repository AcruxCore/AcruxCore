import prisma from '../../shared/db/client';
import { Prisma, team_role } from '@prisma/client';
import type { MemberListItem } from './members.types';

/**
 * All database access for team_members.
 */
export class MembersRepository {
  /**
   * Checks whether a user is already a member of a team.
   *
   * @param teamId - Team to check.
   * @param userId - User to check.
   * @returns true if the user has a team_members row for this team.
   */
  async isMember(teamId: string, userId: string): Promise<boolean> {
    const row = await prisma.teamMember.findFirst({
      where: { teamId, userId },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Returns the role held by a user in a team.
   *
   * @param teamId - Team context.
   * @param userId - User whose role to fetch.
   * @returns The role, or null if not a member.
   */
  async getRoleForUser(teamId: string, userId: string): Promise<team_role | null> {
    const row = await prisma.teamMember.findFirst({
      where: { teamId, userId },
      select: { role: true },
    });
    return row?.role ?? null;
  }

  /**
   * Atomically creates a team_member row with its role, and marks the invite used.
   * Returns the team's id and name for the accept-invite response.
   *
   * @param teamId   - Team to join.
   * @param userId   - User joining.
   * @param role     - Role to assign.
   * @param inviteId - Invite to mark used; omit for seed/test data.
   * @returns The team row (id + name).
   */
  async addMemberWithRole(
    teamId: string,
    userId: string,
    role: team_role,
    inviteId?: string,
  ): Promise<{ team: { id: string; name: string } }> {
    return prisma.$transaction(async (tx) => {
      await tx.teamMember.create({
        data: { teamId, userId, role },
      });

      if (inviteId) {
        await tx.teamInvite.update({
          where: { id: inviteId },
          data: { usedAt: new Date() },
        });
      }

      const team = await tx.team.findUniqueOrThrow({
        where: { id: teamId },
        select: { id: true, name: true },
      });

      return { team };
    });
  }

  /**
   * Lists all members of a team with their role and join date, newest-first.
   *
   * @param teamId - Team to list.
   * @returns Array of MemberListItem.
   */
  async listMembersWithRole(teamId: string): Promise<MemberListItem[]> {
    const rows = await prisma.teamMember.findMany({
      where: { teamId },
      include: {
        user: { select: { email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((m) => ({
      userId:   m.userId,
      email:    m.user.email,
      role:     m.role,
      joinedAt: m.createdAt.toISOString(),
    }));
  }

  /**
   * Replaces a member's role with a new one.
   *
   * When called without `tx`, runs inside its own transaction. When called
   * with `tx` (e.g. from `MembersService.updateRole`, which locks the team's
   * owner rows first via `lockOwnerUserIds` in the same transaction), the
   * write joins that transaction instead of opening a new one — this is what
   * closes the check-then-act race on the last-owner guard.
   *
   * @param teamId - Team context.
   * @param userId - User whose role to replace.
   * @param role   - New role.
   * @param tx     - Optional transaction client to join an already-open transaction.
   * @returns The userId and new role, or undefined if the user is not a member.
   */
  async updateRole(
    teamId: string,
    userId: string,
    role: team_role,
    tx?: Prisma.TransactionClient,
  ): Promise<{ userId: string; role: team_role } | undefined> {
    const run = async (client: Prisma.TransactionClient) => {
      const member = await client.teamMember.findFirst({ where: { teamId, userId } });
      if (!member) return undefined;

      await client.teamMember.update({
        where: { id: member.id },
        data: { role },
      });
      return { userId, role };
    };
    if (tx) return run(tx);
    return prisma.$transaction((innerTx) => run(innerTx));
  }

  /**
   * Reads a team's display name, for interpolation into a notification email.
   *
   * @param teamId - Team to name.
   * @returns The name, or null when the team no longer exists.
   */
  async findTeamName(teamId: string): Promise<string | null> {
    const row = await prisma.team.findUnique({ where: { id: teamId }, select: { name: true } });
    return row?.name ?? null;
  }

  /**
   * Returns the distinct users who hold any of the given roles in a team.
   *
   * There is no `owner` column on `Team` — ownership lives in
   * `team_members.role` — so this is the single place "who are the owners
   * and admins of this team" gets answered.
   *
   * @param teamId - Team scope.
   * @param roles - Roles to match; a member needs only one of them.
   * @returns One entry per matching member, with the display name falling back
   *   to the email so a caller never has to handle a null name.
   */
  async findEmailsByRoles(
    teamId: string,
    roles: team_role[],
  ): Promise<{ userId: string; email: string; name: string }[]> {
    if (roles.length === 0) return [];

    const rows = await prisma.teamMember.findMany({
      where: { teamId, role: { in: roles } },
      select: { userId: true, user: { select: { email: true, displayName: true } } },
    });

    return rows.map((r) => ({
      userId: r.userId,
      email: r.user.email,
      name: r.user.displayName ?? r.user.email,
    }));
  }

  /**
   * Returns contact details for specific users, by user id.
   *
   * Reads `users` directly rather than going through team membership on purpose:
   * the member-removed notification must still reach someone whose
   * `team_members` row was deleted a moment earlier.
   *
   * @param userIds - Users to look up. Unknown ids are silently absent from the result.
   * @returns One entry per found user, name falling back to email.
   */
  async findEmailsByUserIds(
    userIds: string[],
  ): Promise<{ userId: string; email: string; name: string }[]> {
    if (userIds.length === 0) return [];

    const rows = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, displayName: true },
    });

    return rows.map((u) => ({
      userId: u.id,
      email: u.email,
      name: u.displayName ?? u.email,
    }));
  }

  /**
   * Removes a member from a team by deleting the team_members row.
   *
   * Accepts an optional `tx` for the same reason `updateRole` does: when
   * `MembersService.remove` locks the team's owner rows via
   * `lockOwnerUserIds` first, the delete must join that same transaction so
   * the lock covers the write, not just the read.
   *
   * @param teamId - Team context.
   * @param userId - User to remove.
   * @param tx     - Optional transaction client to join an already-open transaction.
   * @returns true if removed, false if not found.
   */
  async removeMember(teamId: string, userId: string, tx?: Prisma.TransactionClient): Promise<boolean> {
    const client = tx ?? prisma;
    const member = await client.teamMember.findFirst({ where: { teamId, userId } });
    if (!member) return false;
    await client.teamMember.delete({ where: { id: member.id } });
    return true;
  }

  /**
   * Locks the team's current `owner`-role rows for the lifetime of the caller's
   * transaction, and returns the user ids holding them.
   *
   * This MUST be called with a transaction client (`tx`) that the caller also
   * uses for the subsequent role update / member removal. A plain read (e.g.
   * `findMany`) of "how many owners does this team have" is checked-then-acted-on
   * outside any lock, so two concurrent requests each targeting a different one
   * of a team's two owners can both observe "2 owners, not sole" and both
   * proceed, leaving zero owners. `SELECT ... FOR UPDATE` inside a transaction
   * closes that window: a second transaction's attempt to lock the same rows
   * blocks until the first transaction commits (or rolls back), so the second
   * transaction's re-read reflects the first transaction's write.
   *
   * @param teamId - Team whose owner rows to lock.
   * @param tx     - Open transaction client; the lock is held until this transaction ends.
   * @returns The user ids currently holding the `owner` role in this team.
   */
  async lockOwnerUserIds(teamId: string, tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.$queryRaw<{ user_id: string }[]>(Prisma.sql`
      SELECT tm.user_id
      FROM team_members tm
      WHERE tm.team_id = ${teamId}::uuid AND tm.role = 'owner'::team_role
      FOR UPDATE OF tm
    `);
    return rows.map((r) => r.user_id);
  }
}
