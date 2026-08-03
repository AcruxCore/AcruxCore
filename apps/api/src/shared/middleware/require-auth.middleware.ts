import { Request, Response, NextFunction } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { UnauthorizedError } from '../errors';
import { getSessionFromHeaders } from '../auth';
import { AuthRepository } from '../../auth/auth.repository';
import { AuthService } from '../../auth/auth.service';

const authService = new AuthService(new AuthRepository());

/**
 * Authenticates a request from its Better Auth session cookie, then resolves the
 * team it acts in and attaches `req.user` + `req.teamId`.
 *
 * The cookie is httpOnly, so unlike the Bearer token it replaced it cannot be
 * read by any script on the page — an XSS can no longer walk off with a usable
 * credential. It is also opaque rather than self-describing: the value must match
 * a row in `auth_sessions`, which is what makes signing out a row delete that
 * takes effect immediately instead of a wait for a JWT to expire.
 *
 * The active team comes from {@link AuthService.resolveActiveTeam}, preserving
 * the removed-member protection the JWT path had.
 *
 * @throws {UnauthorizedError} If no valid session cookie is present.
 * @throws {NotFoundError} If the session is valid but no team can be resolved for
 *   it — forwarded from {@link AuthService.resolveActiveTeam}, so a caller cannot
 *   assume every rejection here is a 401.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const identity = await getSessionFromHeaders(fromNodeHeaders(req.headers));
    if (!identity) {
      throw new UnauthorizedError('Authentication required.');
    }

    const { user, teamId } = await authService.resolveActiveTeam(identity);
    req.user = user;
    req.teamId = teamId;
    next();
  } catch (err) {
    next(err);
  }
}
