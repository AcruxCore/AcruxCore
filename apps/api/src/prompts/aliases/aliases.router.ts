import { Router } from 'express';
import { requireAnyAuth, requireRole, validateUuidParam } from '../../shared/middleware';
import { listAliasesHandler, promoteAliasHandler, deleteAliasHandler, renderHandler } from './aliases.controller';

/**
 * Router for alias management endpoints (mounted under /api/v1/prompts in app.ts).
 */
export const aliasesRouter = Router({ mergeParams: true });

// List aliases for a prompt — any authenticated user
aliasesRouter.get('/:id/aliases', requireAnyAuth, validateUuidParam('id'), listAliasesHandler);

// Delete a custom alias — editor and above only
aliasesRouter.delete(
  '/:id/aliases/:alias',
  requireAnyAuth,
  validateUuidParam('id'),
  requireRole('owner', 'admin', 'editor'),
  deleteAliasHandler,
);

// Promote an alias to a version — editor and above only
aliasesRouter.post(
  '/:id/aliases/:alias/promote',
  requireAnyAuth,
  validateUuidParam('id'),
  requireRole('owner', 'admin', 'editor'),
  promoteAliasHandler,
);

/**
 * Router for the render endpoint (separate mount path — uses :name not :id).
 */
export const renderRouter = Router({ mergeParams: true });

// Render a prompt by name + alias — any authenticated user (session or API key)
renderRouter.post('/:name/:alias/render', requireAnyAuth, renderHandler);
