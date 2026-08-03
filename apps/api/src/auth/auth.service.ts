import { AuthRepository } from './auth.repository';
import {
  MeResponseDto,
  MyTeamsResponseDto,
  UserDto,
} from './auth.types';
import { NotFoundError } from '../shared/errors';

/**
 * Business logic for the auth domain: resolving which team an authenticated
 * request acts on, plus the me/teams/switch-team use-cases.
 *
 * Credentials are Better Auth's concern — this service never hashes, compares,
 * or even sees a password. What it owns is the mapping from "a valid session" to
 * "a user acting in a specific team", which is the part of authentication this
 * product's authorization model actually depends on.
 * Throws typed errors; never returns HTTP status codes.
 */
export class AuthService {
  constructor(private readonly repo: AuthRepository) {}

  /**
   * Resolves the active team for an already-authenticated session.
   *
   * The user row exists by construction — Better Auth created it at signup — so
   * this no longer find-or-creates an identity. What it does resolve is *which*
   * team the request acts on: the recorded default if the user is still a member,
   * otherwise their oldest membership. That order is what stops a user who was
   * removed from a team from continuing to act in it.
   *
   * A user with no membership at all is repaired rather than rejected. That state
   * should be unreachable (the `user.create.after` hook gives every account its
   * own team), but if that hook ever failed the account would be permanently
   * unusable — every authenticated route 404ing — with no way for the person to
   * fix it. Healing here costs one query on a path that is already exceptional.
   *
   * @param identity - The verified session's user id, email, and display name.
   * @returns The user DTO and the resolved active team id.
   * @throws {NotFoundError} If the team cannot be resolved or created.
   */
  async resolveActiveTeam(identity: {
    userId: string;
    email: string;
    displayName: string | null;
  }): Promise<{ user: UserDto; teamId: string }> {
    const defaultTeamId = await this.repo.findDefaultTeamId(identity.userId);

    let team =
      defaultTeamId && (await this.repo.isMember(identity.userId, defaultTeamId))
        ? await this.repo.findTeamById(defaultTeamId)
        : undefined;
    if (!team) {
      team = await this.repo.findTeamForUser(identity.userId);
    }
    if (!team) {
      team = await this.repo.ensurePersonalTeam(identity.userId, identity.email);
    }
    if (!team) {
      throw new NotFoundError('No team found for this account.');
    }

    return {
      user: {
        id: identity.userId,
        email: identity.email,
        displayName: identity.displayName,
      },
      teamId: team.id,
    };
  }

  /**
   * Builds the GET /auth/me response.
   * `user` comes pre-validated from `req.user` (attached by requireAuth middleware),
   * so no extra user DB lookup is needed here.
   *
   * @param user - The validated user object from req.user.
   * @param teamId - From req.teamId (set by requireAuth from session).
   * @throws {NotFoundError} If the team row is missing (edge case: team was deleted).
   */
  async getMe(user: UserDto, teamId: string): Promise<MeResponseDto> {
    const [team, role] = await Promise.all([
      this.repo.findTeamById(teamId),
      this.repo.findRoleForUserInTeam(user.id, teamId),
    ]);

    if (!team || !role) {
      throw new NotFoundError('Team not found.');
    }

    return {
      user,
      team: { id: team.id, name: team.name },
      role,
    };
  }

  /**
   * Lists the teams the authenticated user belongs to, with their role in each.
   *
   * @param userId - From the session.
   * @returns The teams-with-role response body.
   */
  async listMyTeams(userId: string): Promise<MyTeamsResponseDto> {
    return { teams: await this.repo.listTeamsForUser(userId) };
  }

  /**
   * Switches the user's active team. Verifies membership, records the choice as
   * the new default, and returns the me-shaped payload for the new team.
   *
   * @param user - The authenticated user, from req.user.
   * @param teamId - Target team UUID.
   * @returns Me-shaped payload: user, team, role for the new team.
   * @throws {NotFoundError} If the user is not a member of the target team
   *   (generic message — foreign teams are indistinguishable from missing ones).
   */
  async switchTeam(user: UserDto, teamId: string): Promise<MeResponseDto> {
    if (!(await this.repo.isMember(user.id, teamId))) {
      throw new NotFoundError('Team not found.');
    }
    const [team, role] = await Promise.all([
      this.repo.findTeamById(teamId),
      this.repo.findRoleForUserInTeam(user.id, teamId),
    ]);
    if (!team || !role) {
      throw new NotFoundError('Team not found.');
    }
    await this.repo.setDefaultTeam(user.id, teamId);
    return { user, team: { id: team.id, name: team.name }, role };
  }
}
