import { Router } from 'express';
import { requireAnyAuth, requireRole } from '../../shared/middleware';
import { executeToolHandler } from './execute.controller';

/** Tool execute route: `POST /tools/:id/execute`. Mounted at `/api/v1` in app.ts. */
export const toolExecuteRouter = Router();
toolExecuteRouter.post('/tools/:id/execute', requireAnyAuth, requireRole('owner', 'admin', 'editor'), executeToolHandler);
