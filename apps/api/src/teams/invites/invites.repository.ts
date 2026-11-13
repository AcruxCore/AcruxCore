import prisma from '../../shared/db/client';
import type { Prisma, team_role } from '@prisma/client';
import type { InviteListItem } from './invites.types';
import { randomBytes } from 'crypto';

/**
 * All database access for the team_invites table.
 */
export class InvitesRepository {
  /**
   * Creates a new invite with a cryptographically random token.
   * Expiry defaults to 7 days (set by the DB default in schema).
   *
   * @param teamId    - Team the invite is for.
   * @param invitedBy - User who created the invite.
   * @param role      - Role to grant the joinee.
   * @param email     - Recipient to email the invite to, or omitted for a
   *   copy-link invite.
   * @returns The created invite's id, token, role, recipient email, expiry,
   *   and creation time.
   */
  async create(
    teamId: string,
    invitedBy: string,
    role: team_role,
    email?: string,
  ): Promise<{
    id: string;
    token: string;
    role: team_role;
    email: string | null;
    expiresAt: Date;
    createdAt: Date;
  }> {
    const token = randomBytes(32).toString('hex');

    const invite = await prisma.teamInvite.create({
      data: { teamId, invitedBy, token, role, email: email ?? null },
      select: { id: true, token: true, role: true, email: true, expiresAt: true, createdAt: true },
    });

    return invite;
  }

  /**
   * Reads the display values the invite email needs.
   *
   * Lives here rather than in the service because services never import
   * `prisma`. Falls back to the inviter's email when they have no display name.
   *
   * @param teamId - Team the invite is for.
   * @param inviterId - User who created the invite.
   * @returns Team name and a human label for the inviter, or null when either
   *   row is missing.
   */
  async findTeamAndInviter(
    teamId: string,
    inviterId: string,
  ): Promise<{ teamName: string; inviterName: string } | null> {
    const [team, inviter] = await Promise.all([
      prisma.team.findUnique({ where: { id: teamId }, select: { name: true } }),
      prisma.user.findUnique({
        where: { id: inviterId },
        select: { displayName: true, email: true },
      }),
    ]);
    if (!team || !inviter) return null;
    return {
      teamName: team.name,
      inviterName: inviter.displayName ?? inviter.email,
    };
  }

  /**
   * Finds any invite by token (including used and expired ones).
   * Used by the accept flow so the service can distinguish "not found", "used",
   * and "expired" and return distinct error codes.
   *
   * @param token - The invite token from the URL.
   * @returns The invite row or null if the token is unknown.
   */
  async findByToken(token: string): Promise<{
    id: string;
    teamId: string;
    invitedBy: string;
    role: team_role;
    /** Address the invite was addressed to, or null for a share-anyone link. */
    email: string | null;
    expiresAt: Date;
    usedAt: Date | null;
  } | null> {
    return prisma.teamInvite.findFirst({
      where: { token },
      select: {
        id: true,
        teamId: true,
        invitedBy: true,
        role: true,
        // Selected so `acceptInvite` can check the caller is who the invite named.
        email: true,
        expiresAt: true,
        usedAt: true,
      },
    });
  }

  /**
   * Lists pending (unused, unexpired) invites for a team, newest-first.
   *
   * @param teamId - Team context.
   * @returns Array of InviteListItem.
   */
  async findPendingByTeam(teamId: string): Promise<InviteListItem[]> {
    const rows = await prisma.teamInvite.findMany({
      where: { teamId, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: {
        id:        true,
        token:     true,
        role:      true,
        invitedBy: true,
        email:     true,
        expiresAt: true,
        createdAt: true,
      },
    });

    return rows.map((r) => ({
      id:        r.id,
      token:     r.token,
      role:      r.role,
      invitedBy: r.invitedBy,
      email:     r.email,
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Soft-marks an invite as used by setting usedAt = now().
   * Used inside addMemberWithRole transaction; also exposed for direct use.
   *
   * @param id - Invite UUID.
   */
  async markUsed(id: string): Promise<void> {
    await prisma.teamInvite.update({
      where: { id },
      data: { usedAt: new Date() },
    });
  }

  /**
   * Hard-deletes an invite row (revoke).
   *
   * @param id     - Invite UUID.
   * @param teamId - Isolation: only deletes if the invite belongs to this team.
   * @returns true if deleted, false if not found or wrong team.
   */
  async deleteById(id: string, teamId: string): Promise<boolean> {
    const invite = await prisma.teamInvite.findFirst({ where: { id, teamId } });
    if (!invite) return false;
    await prisma.teamInvite.delete({ where: { id } });
    return true;
  }

  /**
   * Deletes every still-pending invite one user created for one team.
   *
   * An invite is authority its creator delegated: it grants whatever role they
   * chose, to whoever holds the link. When the creator loses that authority —
   * removed from the team, or demoted below admin — the invites they minted must
   * go with it, or a removed admin keeps a link that lets them (or anyone they
   * gave it to) straight back in. Used invites are kept: they are history, and
   * deleting them would orphan nothing but the audit trail's reference.
   *
   * Expired-but-unused rows are deleted too; they are already unusable, and
   * leaving them would only keep stale rows around.
   *
   * @param teamId    - Team whose invites to revoke; other teams the user admins are untouched.
   * @param invitedBy - The creator whose authority was withdrawn.
   * @param tx        - Transaction client, so the revocation commits or rolls back
   *   together with the membership change that caused it.
   * @returns How many invites were deleted.
   */
  async deletePendingByInviter(
    teamId: string,
    invitedBy: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.teamInvite.deleteMany({
      where: { teamId, invitedBy, usedAt: null },
    });
    return count;
  }
}
