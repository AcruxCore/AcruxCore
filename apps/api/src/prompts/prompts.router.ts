import { Router } from 'express';
import { PromptsRepository } from './prompts.repository';
import { PromptsService } from './prompts.service';
import { PromptsController } from './prompts.controller';
import { requireAnyAuth, requireRole, validateUuidParam } from '../shared/middleware';

const repo = new PromptsRepository();
const service = new PromptsService(repo);
const controller = new PromptsController(service);

/**
 * Express router for all /prompts endpoints.
 * Mounting prefix (/api/v1) is applied in app.ts.
 */
export const promptsRouter = Router();

promptsRouter.post(
  '/prompts',
  requireAnyAuth,
  requireRole('owner', 'admin', 'editor'),
  controller.create,
);

promptsRouter.get('/prompts', requireAnyAuth, controller.list);

promptsRouter.get('/prompts/:id', requireAnyAuth, validateUuidParam('id'), controller.getById);

promptsRouter.patch(
  '/prompts/:id',
  requireAnyAuth,
  validateUuidParam('id'),
  requireRole('owner', 'admin', 'editor'),
  controller.update,
);

promptsRouter.delete(
  '/prompts/:id',
  requireAnyAuth,
  validateUuidParam('id'),
  requireRole('owner', 'admin', 'editor'),
  controller.remove,
);
