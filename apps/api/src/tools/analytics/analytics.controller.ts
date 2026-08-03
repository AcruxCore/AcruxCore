import { Request, Response, NextFunction } from 'express';
import { ToolAnalyticsService } from './analytics.service';
import { AnalyticsQuerySchema } from './analytics.types';
import { ValidationError } from '../../shared/errors';

/**
 * HTTP handler for the tool analytics domain (read-only aggregation).
 * Validate → call service → respond. No business logic here.
 */
export class ToolAnalyticsController {
  constructor(private readonly service: ToolAnalyticsService) {}

  /**
   * GET /api/v1/tools/analytics
   * Returns per-tool call counts, error rates, and latency percentiles for the
   * current team, optionally windowed by `since`/`until` ISO-8601 timestamps.
   */
  getStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = AnalyticsQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.stats(req.teamId!, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}
