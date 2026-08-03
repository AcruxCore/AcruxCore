import { Router, type IRouter } from 'express';
import { requireAnyAuth } from '../../shared/middleware';
import { AnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

const repo = new AnalyticsRepository();
const service = new AnalyticsService(repo);
const ctrl = new AnalyticsController(service);

/**
 * Router for trace analytics. Mounted at /api/v1/traces in app.ts (folded into the
 * aggregate `tracesRouter`), and registered BEFORE any `/traces/:id` route so the
 * static `/traces/analytics` path is not matched as an id. Read-only, any-member
 * (requireAnyAuth, no requireRole).
 */
export const analyticsRouter: IRouter = Router();

analyticsRouter.get('/analytics', requireAnyAuth, ctrl.getAnalytics);
