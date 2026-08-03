import { Request, Response, NextFunction } from 'express';
import { TraceSettingsService } from './settings.service';
import { UpdateTraceSettingsSchema } from './settings.types';
import { ValidationError } from '../../shared/errors';

/**
 * HTTP handlers for /api/v1/traces/settings. Assumes `req.teamId` (and, for PUT,
 * `req.user`) are set by upstream auth middleware.
 */
export class TraceSettingsController {
  constructor(private readonly service: TraceSettingsService) {}

  /** GET /api/v1/traces/settings — read the team's trace settings (any member). */
  get = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.get(req.teamId!);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** PUT /api/v1/traces/settings — toggle payload capture (owner/admin). */
  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = UpdateTraceSettingsSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.update(req.teamId!, req.user!.id, parsed.data.capturePayloads);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}
