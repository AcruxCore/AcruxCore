import type { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../../shared/errors';
import { AnalyticsService } from './analytics.service';
import { AnalyticsQuerySchema, ScoresQuerySchema } from './analytics.types';

/** HTTP boundary for trace analytics. Validates input, delegates, responds. */
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  /** GET /api/v1/traces/analytics — grouped volume/error/token/cost/latency aggregate. */
  getAnalytics = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = AnalyticsQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      const result = await this.service.getAnalytics(req.teamId!, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/traces/analytics/scores — thumbs feedback and online-eval verdicts over time. */
  getScores = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = ScoresQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      res.status(200).json(await this.service.getScores(req.teamId!, parsed.data));
    } catch (err) {
      next(err);
    }
  };
}
