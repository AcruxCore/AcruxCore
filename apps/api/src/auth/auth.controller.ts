import { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth.service';
import { SwitchTeamSchema } from './auth.types';
import { ValidationError } from '../shared/errors';
import { isGoogleEnabled, loadAuthConfig } from '../shared/auth';

/**
 * HTTP handlers for the auth domain.
 * Signup, login, sign-out, password reset, and email verification are served by
 * Better Auth's own handler; nothing in this class touches a credential.
 * These handlers cover identity read-back (me), team listing, and team switching.
 * Each handler does exactly three things: validate → call service → respond.
 */
export class AuthController {
  constructor(private readonly service: AuthService) {}

  /**
   * GET /api/v1/auth/capabilities
   *
   * Tells the sign-in pages which methods this deployment actually supports, so
   * the browser stops offering ones that cannot work. Without it every install
   * renders a "Continue with Google" button, and a self-hoster who configured no
   * Google credentials gets an error from a button that should not have been
   * there. Deliberately unauthenticated — it is read *before* anyone can sign
   * in, and it exposes only which doors exist, never a credential.
   */
  capabilities = (_req: Request, res: Response, next: NextFunction): void => {
    try {
      res.status(200).json({
        google: isGoogleEnabled(),
        email_verification_required: loadAuthConfig().requireEmailVerification,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/auth/me
   * Returns the authenticated user, their active team, and their role.
   * Protected by requireAuth — req.user and req.teamId are guaranteed non-null.
   */
  me = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.getMe(req.user!, req.teamId!);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/auth/teams
   * Lists the teams the authenticated user belongs to. Protected by requireAuth.
   */
  myTeams = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.listMyTeams(req.user!.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/v1/auth/switch-team
   * Switches the active team (membership-checked) and persists it as the user's
   * default (read back by requireAuth on the next request). Protected by
   * requireAuth. Returns the me-shaped payload.
   */
  switchTeam = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = SwitchTeamSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0].message);
      }
      const result = await this.service.switchTeam(req.user!, parsed.data.teamId);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}
