import { Request, Response, NextFunction } from 'express';
import prisma from '../db/client';
import { ForbiddenError, UnauthorizedError } from '../errors';

/**
 * Middleware factory that enforces role-based access control using `req.teamId`
 * (the team from the authenticated session or personal API key).
 * Must be used after `requireAuth` or `requireApiKey`.
 *
 * Use this for prompt/version/alias/api-key routes where `:id` is NOT a team UUID.
 * For team-management routes where `:id` IS the target team, use `requireTeamRole`.
 *
 * @param allowedRoles - One or more role names that are permitted to proceed.
 * @returns Express middleware that resolves or rejects based on the user's roles.
 * @throws {UnauthorizedError} If req.user or req.teamId are not set.
 * @throws {ForbiddenError} If the user holds none of the allowed roles.
 */
export function requireRole(...allowedRoles: string[]) {
  const guard = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.teamId) {
        throw new UnauthorizedError('Authentication required.');
      }

      // Team-scoped API keys have no user identity and cannot hold a role
      if (!req.user) {
        throw new ForbiddenError('TEAM_KEY_NOT_PERMITTED', 'Team API keys cannot perform this action.');
      }

      // `requireApiKey` already joined this row to check the key's owner is still a
      // member, so on the API-key path the role is here and no second read is needed.
      // A session sets nothing, and falls through to the query.
      const role =
        req.teamRole ??
        (
          await prisma.teamMember.findFirst({
            where: { userId: req.user.id, teamId: req.teamId },
            select: { role: true },
          })
        )?.role;

      if (!role || !allowedRoles.includes(role)) {
        throw new ForbiddenError('Insufficient role for this action.');
      }

      next();
    } catch (err) {
      next(err);
    }
  };
  // Named so it is legible in a stack trace, and so `route-policy.test.ts` can walk the
  // mounted router tree and see WHICH roles a route allows rather than only that some
  // middleware is present.
  Object.defineProperty(guard, 'name', { value: `requireRole(${allowedRoles.join('|')})` });
  return guard;
}

/**
 * Middleware factory for team-management routes where `req.params.id` is the
 * target team UUID (e.g. PATCH /teams/:id/members/:userId/roles).
 * Checks that the authenticated user holds one of `allowedRoles` in the team
 * identified by `req.params.id`.
 *
 * Unlike `requireRole`, the team comes from the URL rather than the caller's
 * current context, so a session can manage any team its user belongs to. An API
 * key is additionally pinned to its own `api_keys.team_id`: the URL may not move
 * a key outside the team it was minted for.
 *
 * Team-scoped API keys (req.user is undefined) are rejected immediately since
 * they cannot hold a personal role in a team.
 *
 * @param allowedRoles - One or more roles; caller's role must be one of them.
 * @returns Express middleware.
 * @throws {ForbiddenError} If the user has insufficient role in the target team.
 */
export function requireTeamRole(...allowedRoles: string[]) {
  const guard = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new ForbiddenError('TEAM_KEY_NOT_PERMITTED', 'Team API keys cannot manage members.');
      }

      const teamId = req.params['id'];
      if (!teamId) {
        throw new ForbiddenError('No team context.');
      }

      // An API key carries its own team scope, and `api_keys.team_id` is what
      // limits it on every other route. Using only the URL's team let a key minted
      // for one team manage any other team its owner happened to administer — so a
      // key handed to CI or a contractor also carried the holder's admin rights
      // elsewhere. A browser session is different: its `teamId` is just the team
      // being viewed, so it keeps being checked by membership alone.
      if (req.authMethod === 'api_key' && req.teamId !== teamId) {
        throw new ForbiddenError(
          'KEY_TEAM_MISMATCH',
          'This API key belongs to a different team.',
        );
      }

      const member = await prisma.teamMember.findFirst({
        where: { userId: req.user.id, teamId },
        select: { role: true },
      });

      if (!member || !allowedRoles.includes(member.role)) {
        throw new ForbiddenError('Insufficient role for this action.');
      }

      next();
    } catch (err) {
      next(err);
    }
  };
  // See the note on `requireRole` above.
  Object.defineProperty(guard, 'name', { value: `requireTeamRole(${allowedRoles.join('|')})` });
  return guard;
}
