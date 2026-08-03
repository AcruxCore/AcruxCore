import { Router } from 'express';
import { requireAnyAuth, requireRole } from '../../shared/middleware';
import { listToolAliasesHandler, promoteToolAliasHandler } from './aliases.controller';

/**
 * Router for tool alias endpoints. Mounted UNDER /api/v1/tools in app.ts
 * (mirrors how prompts' aliasesRouter mounts under /api/v1/prompts).
 */
export const toolAliasesRouter = Router({ mergeParams: true });

// List aliases for a tool — any authenticated user
toolAliasesRouter.get('/:id/aliases', requireAnyAuth, listToolAliasesHandler);

// Promote an alias to a version — editor and above only
toolAliasesRouter.post(
  '/:id/aliases/:alias/promote',
  requireAnyAuth,
  requireRole('owner', 'admin', 'editor'),
  promoteToolAliasHandler,
);
