import { Router, type IRouter } from 'express';
import { settingsRouter } from './settings';
import { analyticsRouter } from './analytics';
import { facetsRouter } from './facets';

/**
 * Aggregates the Phase 3 traces sub-routers under one router, mounted at
 * `/api/v1/traces` in app.ts. Static-path sub-routers (settings; analytics;
 * facets) are mounted BEFORE the `/:id` param route (T4's `traceQueryRouter`,
 * mounted separately at `/api/v1` after this router) so `/traces/settings`,
 * `/traces/analytics`, `/traces/facets`, and `/traces/facets/values` are never
 * swallowed by `/traces/:id`.
 */
export const tracesRouter: IRouter = Router();

tracesRouter.use(settingsRouter);
tracesRouter.use(analyticsRouter);
tracesRouter.use(facetsRouter);
