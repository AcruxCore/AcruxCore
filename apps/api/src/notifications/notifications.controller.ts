import type { NextFunction, Request, Response } from 'express';
import { NotificationsService } from './notifications.service';
import { UpdatePreferenceSchema } from './notifications.types';
import { ValidationError } from '../shared/errors';

/**
 * HTTP handlers for `/api/v1/notifications/preferences`.
 *
 * Both routes read `req.user!.id` and `req.teamId!`, so a caller can only ever
 * read or write their own preferences in their own active team — there is no
 * path that takes a user id from the request.
 */
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  /** GET — effective preferences for the caller in their active team. */
  get = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const preferences = await this.service.get(req.teamId!, req.user!.id);
      res.status(200).json({ preferences });
    } catch (err) {
      next(err);
    }
  };

  /** PATCH — set one category for the caller in their active team. */
  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = UpdatePreferenceSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const preferences = await this.service.update(req.teamId!, req.user!.id, parsed.data);
      res.status(200).json({ preferences });
    } catch (err) {
      next(err);
    }
  };
}
