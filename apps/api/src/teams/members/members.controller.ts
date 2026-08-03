import { Request, Response, NextFunction } from 'express';
import { MembersService } from './members.service';
import { UpdateRoleSchema } from './members.types';
import { ValidationError } from '../../shared/errors';

/**
 * HTTP handlers for the team members domain.
 * Each handler: validate → call service → respond. No business logic here.
 */
export class MembersController {
  constructor(private readonly service: MembersService) {}

  /**
   * GET /api/v1/teams/:id/members
   * Lists all members of the team with the role each of them currently holds.
   */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.list(req.params.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * PATCH /api/v1/teams/:id/members/:userId/roles
   * Replaces the target member's role with the supplied one.
   */
  updateRole = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = UpdateRoleSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.updateRole(
        req.params.id,
        req.user!.id,
        req.params.userId,
        parsed.data,
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * DELETE /api/v1/teams/:id/members/:userId
   * Removes the target member from the team.
   */
  remove = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.service.remove(req.params.id, req.user!.id, req.params.userId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  };
}
