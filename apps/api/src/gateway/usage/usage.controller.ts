import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../shared/errors';
import { UsageService } from './usage.service';
import { UsageQuerySchema, RequestListQuerySchema } from './usage.types';

const IdSchema = z.string().uuid('Invalid request id.');

/** HTTP boundary for usage analytics. Validates input, delegates, responds. */
export class UsageController {
  constructor(private readonly service: UsageService) {}

  /** GET /api/v1/gateway/usage — grouped spend/usage aggregate. */
  getUsage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = UsageQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      const result = await this.service.getUsage(req.teamId!, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/gateway/requests — paginated request log. */
  listRequests = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = RequestListQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      const result = await this.service.listRequests(req.teamId!, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/gateway/requests/:id — single request detail. */
  getRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = IdSchema.safeParse(req.params.id);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      const result = await this.service.getRequestDetail(req.teamId!, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}
