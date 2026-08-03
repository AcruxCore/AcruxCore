import { Router, type IRouter } from 'express';
import { requireAnyAuth } from '../../shared/middleware';
import { UsageRepository } from './usage.repository';
import { UsageService } from './usage.service';
import { UsageController } from './usage.controller';

const repo = new UsageRepository();
const service = new UsageService(repo);
const ctrl = new UsageController(service);

/**
 * Router for gateway usage analytics. Mounted at /api/v1/gateway in app.ts.
 * All routes are read-only and any-role (requireAnyAuth, no requireRole).
 * `/requests/:id` is declared after `/requests` — Express matches the static
 * segment order correctly, but keeping them adjacent documents intent.
 */
export const usageRouter: IRouter = Router();

usageRouter.get('/usage', requireAnyAuth, ctrl.getUsage);
usageRouter.get('/requests', requireAnyAuth, ctrl.listRequests);
usageRouter.get('/requests/:id', requireAnyAuth, ctrl.getRequest);
