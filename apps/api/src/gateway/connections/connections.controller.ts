import { Request, Response, NextFunction } from 'express';
import { ConnectionsService } from './connections.service';
import { CreateConnectionSchema, UpdateConnectionSchema } from './connections.types';
import { ValidationError } from '../../shared/errors';

/**
 * HTTP handlers for provider-connection management. Assumes `req.user` and
 * `req.teamId` are set by upstream auth middleware.
 */
export class ConnectionsController {
  constructor(private readonly service: ConnectionsService) {}

  /** POST /api/v1/gateway/connections — create a connection (owner/admin). */
  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = CreateConnectionSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.create(req.teamId!, req.user!.id, parsed.data);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/gateway/connections — list the team's connections (any role). */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.list(req.teamId!);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/gateway/connections/:id — get one masked connection (any role). */
  get = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.get(req.params.id, req.teamId!);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** PATCH /api/v1/gateway/connections/:id — update/rotate (owner/admin). */
  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = UpdateConnectionSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.update(req.params.id, req.teamId!, req.user!.id, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** DELETE /api/v1/gateway/connections/:id — hard delete (owner/admin). */
  remove = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.service.delete(req.params.id, req.teamId!, req.user!.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  };
}
