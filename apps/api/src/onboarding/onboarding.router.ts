import { Router, type IRouter } from 'express';
import { requireAnyAuth } from '../shared/middleware';
import { OnboardingRepository } from './onboarding.repository';
import { OnboardingService } from './onboarding.service';
import { OnboardingController } from './onboarding.controller';

const controller = new OnboardingController(new OnboardingService(new OnboardingRepository()));

/**
 * `GET /api/v1/onboarding`. Any role may read it: the status describes the team, and
 * every member lands on the checklist after sign-in until the team is set up.
 */
export const onboardingRouter: IRouter = Router();

onboardingRouter.get('/onboarding', requireAnyAuth, controller.getStatus);
