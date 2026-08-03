import type { Prisma, team_role } from '@prisma/client';
import { MembersRepository } from './members.repository';
import type { MemberListItem, UpdateRoleDto } from './members.types';
import { audit } from '../../shared/audit';
import { ForbiddenError, NotFoundError } from '../../shared/errors';
import prisma from '../../shared/db/client';
import { eventBucket, notify } from '../../notifications';
import { appLink } from '../../email';

/**
 * Business logic for the team members domain.
 * Delegates all DB access to MembersRepository and emits audit events.
 */
export class MembersService {
  constructor(private readonly repo: MembersRepository) {}

  /**
   * Returns all current members of a team with their role, newest-first.
   * Any authenticated member of the team may list members.
   *
   * @param teamId - The team whose members to list.
   * @returns Array of member summary objects.
   */
  async list(teamId: string): Promise<MemberListItem[]> {
    return this.repo.listMembersWithRole(teamId);
  }

  /**
   * Replaces a member's role with a new one.
   * The owner role cannot be granted through this endpoint — it is set only at team creation.
   * Cannot demote the last owner.
   *
   * @param teamId  - The team context.
   * @param actorId - The user making the change (for audit).
   * @param userId  - The target user whose role will change.
   * @param dto     - Validated role (admin|editor|viewer only).
   * @returns The updated userId and role.
   * @throws {NotFoundError} If userId is not a member of the team.
   * @throws {ForbiddenError} If the actor tries to demote a protected owner.
   */
  async updateRole(
    teamId: string,
    actorId: string,
    userId: string,
    dto: UpdateRoleDto,
  ): Promise<{ userId: string; role: team_role }> {
    // dto.role is never 'owner' (validated to admin|editor|viewer only), so
    // any update against the team's sole owner is inherently a demotion away
    // from owner — same guard `remove()` uses below.
    //
    // The lock-check-write all happen in ONE transaction so a concurrent
    // request against the team's other owner can't slip through: see
    // `assertNotSoleOwner` and `MembersRepository.lockOwnerUserIds`.
    const result = await prisma.$transaction(async (tx) => {
      await this.assertNotSoleOwner(tx, teamId, userId);
      return this.repo.updateRole(teamId, userId, dto.role, tx);
    });
    if (!result) throw new NotFoundError('Member not found.');

    await audit(prisma, {
      teamId,
      actorId,
      event: 'member_role_updated',
      metadata: { targetUserId: userId, role: dto.role },
    });

    // Notify the affected member plus the team's owners/admins. Placed after the
    // audit event, and `notify()` swallows its own failures, so a mail problem
    // can never undo a role change that already committed.
    const names = await this.displayNames(teamId, actorId, userId);
    await notify({
      teamId,
      category: 'membership',
      audience: { userIds: [userId], roles: ['owner', 'admin'] },
      dedupeKey: `roles:${teamId}:${userId}:${result.role}:${eventBucket()}`,
      payload: {
        type: 'member_roles_changed',
        props: {
          teamName: names.teamName,
          memberName: names.memberName,
          actorName: names.actorName,
          role: result.role,
          teamUrl: appLink('/team'),
        },
      },
    });

    return result;
  }

  /**
   * Guards against leaving a team with zero owners. Shared by `updateRole`
   * (an update against the sole owner is always a demotion, since `owner`
   * cannot appear in an update's target role set) and `remove`.
   *
   * Must be called with the SAME transaction client the caller then uses to
   * perform the write (role update or member removal). `lockOwnerUserIds`
   * takes a row lock (`SELECT ... FOR UPDATE`) on the team's owner rows, so a
   * second concurrent call targeting the same team — even against a
   * *different* owner — blocks here until the first transaction commits.
   * Without that lock, two requests each demoting/removing a different one of
   * a team's two owners could both read "2 owners, not sole" before either
   * write commits, and both proceed, leaving the team with zero owners.
   *
   * @param tx     - Open transaction client shared with the subsequent write.
   * @param teamId - The team context.
   * @param userId - The user who would be demoted/removed.
   * @throws {ForbiddenError} With code `LAST_OWNER` if `userId` is the team's only owner.
   */
  private async assertNotSoleOwner(
    tx: Prisma.TransactionClient,
    teamId: string,
    userId: string,
  ): Promise<void> {
    const ownerIds = await this.repo.lockOwnerUserIds(teamId, tx);
    if (ownerIds.length === 1 && ownerIds[0] === userId) {
      throw new ForbiddenError('LAST_OWNER', 'Cannot demote or remove the last owner of a team.');
    }
  }

  /**
   * Resolves the three human-readable names a membership email interpolates.
   *
   * Falls back to non-empty placeholders rather than propagating nulls: a
   * notification with "undefined removed you from undefined" is worse than a
   * vague one, and none of these lookups is worth failing the operation over.
   *
   * @param teamId - Team the change happened in.
   * @param actorId - Whoever performed the change.
   * @param memberId - The member the change is about.
   * @returns Team, member, and actor display names.
   */
  private async displayNames(
    teamId: string,
    actorId: string,
    memberId: string,
  ): Promise<{ teamName: string; memberName: string; actorName: string }> {
    const [teamName, people] = await Promise.all([
      this.repo.findTeamName(teamId),
      this.repo.findEmailsByUserIds([actorId, memberId]),
    ]);
    const byId = new Map(people.map((p) => [p.userId, p.name]));
    return {
      teamName: teamName ?? 'your team',
      memberName: byId.get(memberId) ?? 'A member',
      actorName: byId.get(actorId) ?? 'A teammate',
    };
  }

  /**
   * Removes a member from a team.
   * A member may remove themselves; owners may remove anyone except the last owner.
   *
   * @param teamId  - The team context.
   * @param actorId - The user performing the removal (for audit).
   * @param userId  - The user to remove.
   * @throws {NotFoundError}   If userId is not a member.
   * @throws {ForbiddenError}  If removing the last owner.
   */
  async remove(teamId: string, actorId: string, userId: string): Promise<void> {
    // Lock-check-delete in ONE transaction, for the same reason `updateRole`
    // does it: see `assertNotSoleOwner` / `MembersRepository.lockOwnerUserIds`.
    const removed = await prisma.$transaction(async (tx) => {
      await this.assertNotSoleOwner(tx, teamId, userId);
      return this.repo.removeMember(teamId, userId, tx);
    });
    if (!removed) throw new NotFoundError('Member not found.');

    // Names are read AFTER the delete now that the delete lives inside the
    // transaction above: `findEmailsByUserIds` reads `users` directly (not
    // through the now-deleted `team_members` row), so the removed person is
    // still resolvable here regardless of ordering.
    const names = await this.displayNames(teamId, actorId, userId);

    await audit(prisma, {
      teamId,
      actorId,
      event: 'member_removed',
      metadata: { targetUserId: userId },
    });

    // `ignorePreferences` is set here and nowhere else: losing access to a team is
    // account-security-adjacent, and the preference row that would record the
    // opt-out belongs to a membership that no longer exists. Documented in spec B
    // §2 as a deliberate exception, not a special case that slipped in.
    await notify({
      teamId,
      category: 'membership',
      audience: { userIds: [userId], roles: ['owner', 'admin'] },
      dedupeKey: `removed:${teamId}:${userId}:${eventBucket()}`,
      ignorePreferences: true,
      payload: {
        type: 'member_removed',
        props: {
          teamName: names.teamName,
          memberName: names.memberName,
          actorName: names.actorName,
          role: null,
          teamUrl: appLink('/team'),
        },
      },
    });
  }
}
