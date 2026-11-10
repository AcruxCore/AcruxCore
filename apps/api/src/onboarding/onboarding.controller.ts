import type { Request, Response, NextFunction } from 'express';
import type { OnboardingService } from './onboarding.service';

/** HTTP boundary for the getting-started status. */
export class OnboardingController {
  constructor(private readonly service: OnboardingService) {}

  /** GET /api/v1/onboarding — which setup steps the active team has finished. */
  getStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json(await this.service.getStatus(req.teamId!));
    } catch (err) {
      next(err);
    }
  };
}
