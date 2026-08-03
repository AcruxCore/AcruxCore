import { Request, Response, NextFunction } from 'express';
import { ModelsService } from './models.service';
import { CreateModelSchema, UpdateModelSchema } from './models.types';
import { ValidationError } from '../../shared/errors';

/**
 * HTTP handlers for the model registry. Assumes `req.user` and `req.teamId` are
 * set by upstream auth middleware.
 */
export class ModelsController {
  constructor(private readonly service: ModelsService) {}

  /** POST /api/v1/gateway/models — register a model (owner/admin). */
  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = CreateModelSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      const result = await this.service.create(req.teamId!, req.user!.id, parsed.data);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/gateway/models — list the team's models (any role). */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.list(req.teamId!);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/gateway/models/:id — get one model (any role). */
  get = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.get(req.params.id, req.teamId!);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** PATCH /api/v1/gateway/models/:id — update (owner/admin). */
  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = UpdateModelSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      const result = await this.service.update(req.params.id, req.teamId!, req.user!.id, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** DELETE /api/v1/gateway/models/:id — delete (owner/admin). */
  remove = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.service.delete(req.params.id, req.teamId!, req.user!.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/v1/gateway/models/:id/test — diagnostic ping (owner/admin). */
  test = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.test(req.params.id, req.teamId!);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}
