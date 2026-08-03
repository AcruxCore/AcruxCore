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
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.teamId) {
        throw new UnauthorizedError('Authentication required.');
      }

      // Team-scoped API keys have no user identity and cannot hold a role
      if (!req.user) {
        throw new ForbiddenError('TEAM_KEY_NOT_PERMITTED', 'Team API keys cannot perform this action.');
      }

      const member = await prisma.teamMember.findFirst({
        where: { userId: req.user.id, teamId: req.teamId },
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
}

/**
 * Middleware factory for team-management routes where `req.params.id` is the
 * target team UUID (e.g. PATCH /teams/:id/members/:userId/roles).
 * Checks that the authenticated user holds one of `allowedRoles` in the team
 * identified by `req.params.id`.
 *
 * Unlike `requireRole`, this prevents cross-team attacks because it ignores
 * `req.teamId` (the caller's home team) and uses the explicitly requested team.
 *
 * Team-scoped API keys (req.user is undefined) are rejected immediately since
 * they cannot hold a personal role in a team.
 *
 * @param allowedRoles - One or more roles; caller's role must be one of them.
 * @returns Express middleware.
 * @throws {ForbiddenError} If the user has insufficient role in the target team.
 */
export function requireTeamRole(...allowedRoles: string[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new ForbiddenError('TEAM_KEY_NOT_PERMITTED', 'Team API keys cannot manage members.');
      }

      const teamId = req.params['id'];
      if (!teamId) {
        throw new ForbiddenError('No team context.');
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
}
