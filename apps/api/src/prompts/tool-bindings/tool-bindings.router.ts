import { Router } from 'express';
import { requireAnyAuth, requireRole, validateUuidParam } from '../../shared/middleware';
import {
  listBindingsHandler,
  setDefaultBindingHandler,
  removeDefaultBindingHandler,
  setAliasBindingHandler,
  removeAliasBindingHandler,
  resetAliasBindingsHandler,
} from './tool-bindings.controller';

/**
 * Routes for prompt→tool bindings, mounted under `/api/v1/prompts`.
 *
 * Two shapes: `/:id/tools/...` writes the default every alias inherits, and
 * `/:id/aliases/:alias/tools/...` writes one alias's own rows. Reads are open to
 * any role; every mutation needs editor or above, matching the rest of prompts.
 */
export const toolBindingsRouter = Router({ mergeParams: true });

// The whole binding picture for one prompt — defaults plus every alias.
toolBindingsRouter.get('/:id/tools', requireAnyAuth, validateUuidParam('id'), listBindingsHandler);

// Default binding — inherited by every alias without a row of its own.
toolBindingsRouter.put(
  '/:id/tools/:toolId',
  requireAnyAuth,
  validateUuidParam('id'),
  validateUuidParam('toolId'),
  requireRole('owner', 'admin', 'editor'),
  setDefaultBindingHandler,
);

toolBindingsRouter.delete(
  '/:id/tools/:toolId',
  requireAnyAuth,
  validateUuidParam('id'),
  validateUuidParam('toolId'),
  requireRole('owner', 'admin', 'editor'),
  removeDefaultBindingHandler,
);

// One alias's own binding, overriding the default for that alias only.
toolBindingsRouter.put(
  '/:id/aliases/:alias/tools/:toolId',
  requireAnyAuth,
  validateUuidParam('id'),
  validateUuidParam('toolId'),
  requireRole('owner', 'admin', 'editor'),
  setAliasBindingHandler,
);

toolBindingsRouter.delete(
  '/:id/aliases/:alias/tools/:toolId',
  requireAnyAuth,
  validateUuidParam('id'),
  validateUuidParam('toolId'),
  requireRole('owner', 'admin', 'editor'),
  removeAliasBindingHandler,
);

// Reset one alias wholesale — the dashboard's per-column ×.
toolBindingsRouter.delete(
  '/:id/aliases/:alias/tools',
  requireAnyAuth,
  validateUuidParam('id'),
  requireRole('owner', 'admin', 'editor'),
  resetAliasBindingsHandler,
);
