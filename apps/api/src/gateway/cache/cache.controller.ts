import type { Request, Response, NextFunction } from 'express';
import { CacheService } from './cache.service';

/**
 * HTTP controller for cache management. Reads the team from the authenticated
 * request context and delegates to CacheService.
 */
export class CacheController {
  constructor(private readonly service: CacheService) {}

  /**
   * DELETE /api/v1/gateway/cache — flush the calling team's response cache.
   * Responds 200 with the number of rows removed.
   */
  flush = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.flushTeam(req.teamId!);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}
