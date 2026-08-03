import { Router, type IRouter } from 'express';
import { ToolAnalyticsRepository } from './analytics.repository';
import { ToolAnalyticsService } from './analytics.service';
import { ToolAnalyticsController } from './analytics.controller';
import { requireAnyAuth } from '../../shared/middleware';

const repo = new ToolAnalyticsRepository();
const service = new ToolAnalyticsService(repo);
const controller = new ToolAnalyticsController(service);

/**
 * Express router for GET /api/v1/tools/analytics (TC7 per-tool analytics).
 * Mounting prefix (/api/v1) is applied in app.ts.
 *
 * Uses `requireAnyAuth` only (no `requireRole`) — matching `tools.router.ts`'s
 * `GET /tools`: this is a read endpoint, viewable by any team member.
 *
 * Must be mounted BEFORE `toolsRouter` in app.ts: `toolsRouter` registers
 * `GET /tools/:id`, and Express would otherwise match `/tools/analytics`
 * as `:id = "analytics"`.
 */
export const toolAnalyticsRouter: IRouter = Router();

toolAnalyticsRouter.get('/tools/analytics', requireAnyAuth, controller.getStats);
