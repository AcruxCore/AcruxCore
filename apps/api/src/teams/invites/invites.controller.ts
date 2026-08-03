import { Request, Response, NextFunction } from 'express';
import { InvitesService } from './invites.service';
import { CreateInviteSchema } from './invites.types';
import { ValidationError } from '../../shared/errors';

/**
 * HTTP handlers for the team invites domain.
 * Each handler: validate → call service → respond. No business logic here.
 */
export class InvitesController {
  constructor(private readonly service: InvitesService) {}

  /**
   * POST /api/v1/teams/:id/invites
   * Generates a new invite link for the team.
   */
  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = CreateInviteSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.generateInvite(
        req.params.id,
        req.user!.id,
        parsed.data,
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/teams/:id/invites
   * Lists all pending (unused, unexpired) invites for the team.
   */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.listPending(req.params.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/v1/teams/invites/:token/accept
   * Accepts an invite — the authenticated user joins the team, which the service
   * records as their default team, so the next authenticated request resolves to
   * the team they just joined. The response reflects that team.
   */
  accept = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.acceptInvite(req.params.token, req.user!.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * DELETE /api/v1/teams/:id/invites/:inviteId
   * Revokes (hard-deletes) a pending invite.
   */
  revoke = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.service.revokeInvite(req.params.id, req.params.inviteId, req.user!.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  };
}
