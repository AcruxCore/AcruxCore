import { Request, Response, NextFunction } from 'express';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeySchema } from './api-keys.types';
import { ValidationError } from '../shared/errors';

/**
 * HTTP handlers for API key management.
 * All handlers assume `req.user` and `req.teamId` are set by upstream auth middleware.
 */
export class ApiKeysController {
  constructor(private readonly service: ApiKeysService) {}

  /**
   * POST /api/v1/api-keys
   * Creates a new API key and returns it in full (the only time the full value is shown).
   */
  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = CreateApiKeySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0].message);
      }

      const result = await this.service.create(req.user!.id, req.teamId!, parsed.data);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/api-keys
   * Lists active keys for the current user+team. Full key value is never returned.
   */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.list(req.user!.id, req.teamId!);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * DELETE /api/v1/api-keys/:id
   * Soft-revokes the key. Returns 404 if not found or not owned by caller.
   */
  revoke = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.service.revoke(req.params.id, req.user!.id, req.teamId!);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/v1/teams/:id/api-keys
   * Creates a new team-scoped API key for the team.
   */
  createTeamApiKey = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = CreateApiKeySchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.createTeamApiKey(req.params.id, parsed.data);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/teams/:id/api-keys
   * Lists active team-scoped keys for the team (masked).
   */
  listTeamApiKeys = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.listTeamApiKeys(req.params.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * DELETE /api/v1/teams/:id/api-keys/:keyId
   * Revokes a team-scoped key. Requires owner or admin role.
   */
  revokeTeamApiKey = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.service.revokeTeamApiKey(req.params.keyId, req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  };
}
