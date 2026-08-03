import { Request, Response, NextFunction } from 'express';
import { VirtualKeysService } from './keys.service';
import { CreateVirtualKeySchema, UpdateVirtualKeySchema } from './keys.types';
import { ValidationError } from '../../shared/errors';

/**
 * HTTP handlers for virtual-key management. Assumes upstream auth middleware has
 * set `req.user` and `req.teamId`.
 */
export class VirtualKeysController {
  constructor(private readonly service: VirtualKeysService) {}

  /**
   * POST /gateway/keys — create a key; returns the plaintext token exactly once.
   *
   * @throws {ValidationError} 400 on an invalid body.
   */
  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = CreateVirtualKeySchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      const result = await this.service.create(req.teamId!, req.user!.id, parsed.data);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /gateway/keys — list masked keys for the caller's team (any role).
   */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.list(req.teamId!);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * PATCH /gateway/keys/:id — update name/scopes/limits.
   *
   * @throws {ValidationError} 400 on an invalid body.
   */
  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = UpdateVirtualKeySchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      const result = await this.service.update(req.params.id, req.teamId!, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * DELETE /gateway/keys/:id — soft-revoke a key.
   */
  revoke = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.service.revoke(req.params.id, req.teamId!, req.user!.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  };
}
