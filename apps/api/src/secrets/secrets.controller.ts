import { Request, Response, NextFunction } from 'express';
import { SecretsService } from './secrets.service';
import { CreateSecretSchema, UpdateSecretSchema } from './secrets.types';
import { ValidationError } from '../shared/errors';

/** HTTP boundary for team Secrets: validate → call service → respond. */
export class SecretsController {
  constructor(private readonly service: SecretsService) {}

  /**
   * `POST /api/v1/secrets` — creates a secret and returns its masked shape.
   *
   * @throws {ValidationError} If the body fails `CreateSecretSchema`.
   */
  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const p = CreateSecretSchema.safeParse(req.body);
      if (!p.success) throw new ValidationError(p.error.issues[0].message);
      res.status(201).json(await this.service.create(req.teamId!, req.user!.id, p.data));
    } catch (e) {
      next(e);
    }
  };

  /** `GET /api/v1/secrets` — lists the caller's team's secrets (masked). */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json(await this.service.list(req.teamId!));
    } catch (e) {
      next(e);
    }
  };

  /**
   * `PUT /api/v1/secrets/:id` — rotates a secret's value.
   *
   * @throws {ValidationError} If the body fails `UpdateSecretSchema`.
   */
  rotate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const p = UpdateSecretSchema.safeParse(req.body);
      if (!p.success) throw new ValidationError(p.error.issues[0].message);
      res.status(200).json(await this.service.rotate(req.params.id, req.teamId!, req.user!.id, p.data));
    } catch (e) {
      next(e);
    }
  };

  /** `DELETE /api/v1/secrets/:id` — deletes an unreferenced secret. */
  remove = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.service.remove(req.params.id, req.teamId!, req.user!.id);
      res.status(204).send();
    } catch (e) {
      next(e);
    }
  };
}
