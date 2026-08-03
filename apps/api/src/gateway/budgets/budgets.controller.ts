import { Request, Response, NextFunction } from 'express';
import { BudgetsService } from './budgets.service';
import { CreateBudgetSchema, UpdateBudgetSchema } from './budgets.types';
import { ValidationError } from '../../shared/errors';

/**
 * HTTP handlers for budget management. Assumes req.user and req.teamId are set
 * by upstream auth middleware, and role has been checked by the router.
 */
export class BudgetsController {
  constructor(private readonly service: BudgetsService) {}

  /** POST /api/v1/gateway/budgets — create a spend cap (owner/admin). */
  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = CreateBudgetSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      const result = await this.service.create(req.teamId!, req.user!.id, parsed.data);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/gateway/budgets — list budgets with live spend (any role). */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json(await this.service.list(req.teamId!));
    } catch (err) {
      next(err);
    }
  };

  /** PATCH /api/v1/gateway/budgets/:id — update limit/period (owner/admin). */
  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = UpdateBudgetSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      const result = await this.service.update(req.teamId!, req.params.id, req.user!.id, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** DELETE /api/v1/gateway/budgets/:id — remove a cap (owner/admin). */
  remove = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.service.delete(req.teamId!, req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  };
}
