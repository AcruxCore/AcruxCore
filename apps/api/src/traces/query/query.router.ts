import { Router, type IRouter } from 'express';
import { requireAnyAuth } from '../../shared/middleware';
import { TraceQueryRepository } from './query.repository';
import { TraceQueryService } from './query.service';
import { TraceQueryController } from './query.controller';

const repo = new TraceQueryRepository();
const service = new TraceQueryService(repo);
const ctrl = new TraceQueryController(service);

/**
 * Router for trace query/search. Mounted at /api/v1 in app.ts, AFTER any static
 * `/traces/*` routers (T1 `/traces/settings`, T5 `/traces/analytics`) so the
 * `/traces/:id` param route does not shadow them. All routes are read-only,
 * any-member (requireAnyAuth, no requireRole).
 */
export const traceQueryRouter: IRouter = Router();

traceQueryRouter.get('/traces', requireAnyAuth, ctrl.listTraces);
traceQueryRouter.get('/traces/:id', requireAnyAuth, ctrl.getTrace);

/**
 * Router for the reverse prompt-version lineage lookup. Mounted at /api/v1 in
 * app.ts. Path is `/prompts/:id/versions/:n/traces` — its extra `/traces` segment
 * means it does not collide with Phase 1's `/prompts/:id/versions/:version_number`.
 */
export const promptTracesRouter: IRouter = Router();

promptTracesRouter.get('/prompts/:id/versions/:n/traces', requireAnyAuth, ctrl.tracesForPromptVersion);
