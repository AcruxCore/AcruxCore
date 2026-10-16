import { Router } from 'express';
import { requireAnyAuth, requireRole, validateUuidParam } from '../../shared/middleware';
import {
  listAliasesHandler,
  promoteAliasHandler,
  deleteAliasHandler,
  renderHandler,
  getVersionByAliasHandler,
} from './aliases.controller';

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

/**
 * Router for resolving an alias by prompt name (mounted under /api/v1 in app.ts). A query
 * string rather than path segments, so no prompt or alias name can collide with the
 * `/prompts/:id/...` routes.
 */
export const versionByAliasRouter = Router();

// The version an alias points at, unrendered — any authenticated user (session or API key)
versionByAliasRouter.get('/prompt-versions', requireAnyAuth, getVersionByAliasHandler);
