import type { Request, Response } from 'express';
import { HealthService } from './health.service';

/**
 * Handles the health-check endpoint. Deliberately outside `requireAnyAuth`:
 * load balancers, Docker `HEALTHCHECK`, and uptime monitors have no API key
 * to send.
 */
export class HealthController {
  constructor(private readonly service: HealthService) {}

  /**
   * Reports database and Redis reachability.
   *
   * @returns 200 with `{ status: 'ok', checks }` when both dependencies
   *   respond, 503 with the same shape (per-check errors included) otherwise.
   */
  get = async (_req: Request, res: Response): Promise<void> => {
    const result = await this.service.check();
    res.status(result.status === 'ok' ? 200 : 503).json(result);
  };
}
