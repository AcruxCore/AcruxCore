import { Router } from 'express';
import { ToolsRepository } from './tools.repository';
import { ToolsService } from './tools.service';
import { ToolsController } from './tools.controller';
import { requireAnyAuth, requireRole } from '../shared/middleware';

const repo = new ToolsRepository();
const service = new ToolsService(repo);
const controller = new ToolsController(service);

/**
 * Express router for all /tools endpoints (Tool shell CRUD).
 * Mounting prefix (/api/v1) is applied in app.ts.
 *
 * Uses `requireAnyAuth` (session OR Bearer API key) on every route — matching
 * `prompts/versions/versions.router.ts` rather than the base `prompts.router.ts`
 * (which is session-only) — since tool mutations are expected to be driven by
 * SDK/API-key clients (e.g. the gateway's `tool_refs` resolver, TC2) as much as
 * by the web session.
 */
export const toolsRouter = Router();

toolsRouter.post(
  '/tools',
  requireAnyAuth,
  requireRole('owner', 'admin', 'editor'),
  controller.create,
);

toolsRouter.get('/tools', requireAnyAuth, controller.list);

toolsRouter.get('/tools/:id', requireAnyAuth, controller.getById);

toolsRouter.patch(
  '/tools/:id',
  requireAnyAuth,
  requireRole('owner', 'admin', 'editor'),
  controller.update,
);

toolsRouter.delete(
  '/tools/:id',
  requireAnyAuth,
  requireRole('owner', 'admin', 'editor'),
  controller.remove,
);
