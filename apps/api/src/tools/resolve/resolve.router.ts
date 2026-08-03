import { Router } from 'express';
import { requireAnyAuth } from '../../shared/middleware';
import { resolveToolsHandler } from './resolve.controller';

/**
 * Tool resolve route: `POST /tools/resolve`. Mounted at `/api/v1` in app.ts, BEFORE
 * `toolsRouter`, so `resolve` is never matched as a `:id`.
 *
 * No `requireRole` gate: resolving returns only what the model would already be shown on
 * a completion call, so any authenticated team member may do it.
 */
export const toolResolveRouter = Router();
toolResolveRouter.post('/tools/resolve', requireAnyAuth, resolveToolsHandler);
