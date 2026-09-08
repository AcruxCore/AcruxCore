import type { NextFunction, Request, Response } from 'express';
import { ViewsService } from './views.service';
import { ValidationError } from '../../shared/errors';
import { CreateViewSchema, ListViewsQuerySchema, UpdateViewSchema } from './views.types';

/** HTTP surface for saved views: validate, call the service, respond. */
export class ViewsController {
  constructor(private readonly service: ViewsService) {}

  /** GET /api/v1/trace-views?surface=traces — the team's views for one surface. */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = ListViewsQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const data = await this.service.list(req.teamId!, parsed.data.surface);
      res.json({ data });
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/v1/trace-views — save the current filter set under a name. */
  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = CreateViewSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const view = await this.service.create(req.teamId!, req.user?.id ?? null, parsed.data);
      res.status(201).json(view);
    } catch (err) {
      next(err);
    }
  };

  /** PATCH /api/v1/trace-views/:id — rename a view or re-point it. */
  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = UpdateViewSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const view = await this.service.update(req.teamId!, req.params.id, parsed.data);
      res.json(view);
    } catch (err) {
      next(err);
    }
  };

  /** DELETE /api/v1/trace-views/:id — 204, no body. */
  remove = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.service.delete(req.teamId!, req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  };
}
