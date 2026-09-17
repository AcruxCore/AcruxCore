import type { team_role } from '@prisma/client';
import { InvitesRepository } from './invites.repository';
import { MembersRepository } from '../members/members.repository';
import { AuthRepository } from '../../auth/auth.repository';
import type { CreateInviteDto, InviteListItem } from './invites.types';
import { audit } from '../../shared/audit';
import { ConflictError, ForbiddenError, GoneError, NotFoundError } from '../../shared/errors';
import prisma from '../../shared/db/client';
import { EmailRepository, EmailService, appLink } from '../../email';
import { notify } from '../../notifications';
import { AppError } from '../../shared/errors/app-error';

/** Trailing window the invite-email cap counts over. */
export const INVITE_EMAIL_WINDOW_MS = 3_600_000;

/**
 * Invite emails one team may send per {@link INVITE_EMAIL_WINDOW_MS}.
 *
 * An authenticated admin could otherwise use invites to mail arbitrary
 * addresses from our verified domain — a spam relay wearing our sending
 * reputation. Twenty invited teammates an hour is far above real use and far
 * below anything worth abusing.
 */
export const INVITE_EMAIL_CAP = 20;

/**
 * Business logic for the team invites domain.
 */
export class InvitesService {
  constructor(
    private readonly invitesRepo: InvitesRepository,
    private readonly membersRepo: MembersRepository,
    private readonly authRepo: AuthRepository,
    private readonly emailService: EmailService,
    private readonly emailRepo: EmailRepository,
  ) {}

  /**
   * Creates a new invite link for the given team with the given role, and —
   * when `dto.email` is present — enqueues the invite email.
   * Emits a `member_invited` audit event.
   *
   * The cap is checked before anything is written, so a rejected request
   * creates no invite row and no log row.
   *
   * @param teamId    - Team to invite into.
   * @param actorId   - User generating the invite.
   * @param dto       - Validated body: role, and optionally a recipient email.
   * @returns The newly-created invite (id, token, role, email, expiresAt, createdAt).
   * @throws {AppError} 429 `EMAIL_RATE_LIMITED` when the team has already sent
   *   {@link INVITE_EMAIL_CAP} invite emails in the trailing hour.
   */
  async generateInvite(
    teamId: string,
    actorId: string,
    dto: CreateInviteDto,
  ): Promise<{
    id: string;
    token: string;
    role: team_role;
    email: string | null;
    expiresAt: string;
    createdAt: string;
  }> {
    if (dto.email) {
      const recent = await this.emailRepo.countRecent(
        teamId,
        'team_invite',
        INVITE_EMAIL_WINDOW_MS,
      );
      if (recent >= INVITE_EMAIL_CAP) {
        throw new AppError(
          `This team has sent ${INVITE_EMAIL_CAP} invite emails in the last hour. Try again later or share the link directly.`,
          429,
          'EMAIL_RATE_LIMITED',
        );
      }
    }

    const invite = await this.invitesRepo.create(teamId, actorId, dto.role, dto.email);

    await audit(prisma, {
      teamId,
      actorId,
      event: 'member_invited',
      metadata: { inviteId: invite.id, role: dto.role, emailed: !!dto.email },
    });

    if (dto.email) {
      const display = await this.invitesRepo.findTeamAndInviter(teamId, actorId);
      try {
        await this.emailService.enqueue({
          teamId,
          to: dto.email,
          dedupeKey: `invite:${invite.id}`,
          payload: {
            type: 'team_invite',
            props: {
              teamName: display?.teamName ?? 'your team',
              inviterName: display?.inviterName ?? 'A teammate',
              role: invite.role,
              inviteUrl: appLink(`/invite/${invite.token}`),
              expiresAt: invite.expiresAt.toISOString(),
            },
          },
        });
      } catch (err) {
        // The invite row and its audit event above are already durable and
        // valid on their own — the link works whether or not the email ever
        // sends. `EmailService`'s own doc promises exactly this for an SES
        // hiccup, but `enqueue()` also touches Redis (twice), and the shared
        // connection's `maxRetriesPerRequest: null` means a Redis outage does
        // not merely error quickly — it can hang this request until the
        // client times out. Swallow it here (after logging, so the admin who
        // never gets an email has a trail) and return the invite anyway: it
        // is the durable artifact, the email is best-effort.
        console.error(`[InvitesService] failed to enqueue invite email for invite ${invite.id}`, err);
      }
    }

    return {
      id:        invite.id,
      token:     invite.token,
      role:      invite.role,
      email:     invite.email,
      expiresAt: invite.expiresAt.toISOString(),
      createdAt: invite.createdAt.toISOString(),
    };
  }

  /**
   * Accepts an invite: verifies the token, adds the user to the team with the
   * invite's role, and marks the invite as used in a single transaction.
   * Also switches the user's active/default team to the one just joined, so
   * they land there instead of appearing to stay on their previous team.
   * Emits a `member_joined` audit event.
   *
   * An invite that named an address may only be accepted by the account holding
   * it. The token travels by email, and a forwarded message, a shared support
   * inbox, a mail-scanning proxy or a browser-history leak all put it in hands it
   * was never sent to — before this check, holding the token was the whole of the
   * authorization, so any of those granted the invite's role. An invite created
   * without an address is a share link by design (`generateInvite` makes `email`
   * optional, and the send-cap message tells an admin to "share the link
   * directly"); it names nobody, so there is nobody to bind it to.
   *
   * The binding is exactly as strong as the deployment's proof that an account
   * owns its address. With `EMAIL_TRANSPORT=none` — a documented self-host setup —
   * `requireEmailVerification` is off, so whoever holds a leaked token for an
   * address that has no account yet can sign up as that address and pass this
   * check. Read it as "only the account holding that address", not as an
   * independent proof of identity. See cross-cutting FAQ Q85.
   *
   * @param token  - The invite token from the URL.
   * @param userId - The user accepting the invite.
   * @returns The team the user just joined (id + name).
   * @throws {NotFoundError}  If the token is unknown, expired, or already used.
   * @throws {ForbiddenError} INVITE_WRONG_ACCOUNT if the invite named a different
   *   address than the caller's. The message does not repeat the invited address:
   *   whoever holds a leaked token has not shown they were meant to know it.
   * @throws {ConflictError}  If the user is already a member of the team.
   * @throws {GoneError}      If the invite has already been used.
   */
  async acceptInvite(
    token: string,
    userId: string,
  ): Promise<{ team: { id: string; name: string } }> {
    const invite = await this.invitesRepo.findByToken(token);
    if (!invite) throw new NotFoundError('Invite not found.');
    if (invite.usedAt) throw new GoneError('INVITE_USED', 'This invite has already been used.');
    if (invite.expiresAt < new Date()) throw new NotFoundError('Invite not found or has expired.');

    if (invite.email) {
      const caller = await this.authRepo.findEmailById(userId);
      // Addresses are compared case-insensitively: an admin typing
      // "Alice@Example.com" means the same mailbox the account calls
      // "alice@example.com", and no mail provider treats those as two people.
      if (caller?.email.toLowerCase() !== invite.email.toLowerCase()) {
        throw new ForbiddenError(
          'INVITE_WRONG_ACCOUNT',
          'This invite was sent to a different email address. Sign in with the address it was sent to, or ask for a new invite.',
        );
      }
    }

    const alreadyMember = await this.membersRepo.isMember(invite.teamId, userId);
    if (alreadyMember) {
      throw new ConflictError('ALREADY_MEMBER', 'You are already a member of this team.');
    }

    const result = await this.membersRepo.addMemberWithRole(
      invite.teamId,
      userId,
      invite.role,
      invite.id,
    );

    await this.authRepo.setDefaultTeam(userId, invite.teamId);

    await audit(prisma, {
      teamId: invite.teamId,
      actorId: userId,
      event: 'member_joined',
      metadata: { inviteId: invite.id, role: invite.role },
    });

    // Tell the team's owners/admins the invite was actually accepted — the
    // counterpart to the invite email, so nobody has to poll the members list.
    // `inviteId` is a genuine natural key here, so no time bucket is needed: a
    // retried accept cannot produce a second email.
    const joiner = await this.membersRepo.findEmailsByUserIds([userId]);
    await notify({
      teamId: invite.teamId,
      category: 'membership',
      audience: { roles: ['owner', 'admin'] },
      dedupeKey: `joined:${invite.id}`,
      payload: {
        type: 'member_joined',
        props: {
          teamName: result.team.name,
          memberName: joiner[0]?.name ?? 'A new member',
          actorName: joiner[0]?.name ?? 'A new member',
          role: invite.role,
          teamUrl: appLink('/team'),
        },
      },
    });

    return result;
  }

  /**
   * Lists all pending (unused, unexpired) invites for a team.
   *
   * @param teamId - Team context.
   * @returns Array of InviteListItem.
   */
  async listPending(teamId: string): Promise<InviteListItem[]> {
    return this.invitesRepo.findPendingByTeam(teamId);
  }

  /**
   * Hard-revokes an invite by deleting it.
   * Emits a `member_invite_revoked` audit event.
   *
   * @param teamId   - Team context (isolation).
   * @param inviteId - Invite to revoke.
   * @param actorId  - User revoking it (for audit).
   * @throws {NotFoundError} If the invite doesn't exist or belongs to another team.
   */
  async revokeInvite(teamId: string, inviteId: string, actorId: string): Promise<void> {
    const deleted = await this.invitesRepo.deleteById(inviteId, teamId);
    if (!deleted) throw new NotFoundError('Invite not found.');

    await audit(prisma, {
      teamId,
      actorId,
      event: 'member_invite_revoked',
      metadata: { inviteId },
    });
  }
}
