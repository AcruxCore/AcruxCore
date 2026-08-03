import { Router } from 'express';
import { requireAnyAuth, requireRole } from '../../shared/middleware';
import { syncToolHandler } from './sync.controller';

/**
 * Tool sync route: `POST /tools/sync`. Mounted at `/api/v1` in app.ts, BEFORE
 * `toolsRouter` — `sync` is a literal path segment and must never be matched as a
 * `:id`, the same reason `toolAnalyticsRouter` is mounted early.
 */
export const toolSyncRouter = Router();
toolSyncRouter.post('/tools/sync', requireAnyAuth, requireRole('owner', 'admin', 'editor'), syncToolHandler);
