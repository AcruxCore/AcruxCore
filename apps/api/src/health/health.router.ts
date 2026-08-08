import { Router, type IRouter } from 'express';
import { HealthController } from './health.controller';
import { HealthRepository } from './health.repository';
import { HealthService } from './health.service';

const service = new HealthService(new HealthRepository());
const controller = new HealthController(service);

/**
 * Router for GET /api/v1/health. Mounting prefix is applied in app.ts.
 */
export const healthRouter: IRouter = Router();

healthRouter.get('/health', controller.get);
