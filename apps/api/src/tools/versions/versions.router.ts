import { Router } from 'express';
import { requireAnyAuth, requireRole } from '../../shared/middleware';
import { createToolVersionHandler, listToolVersionsHandler, getToolVersionHandler } from './versions.controller';

/**
 * Express router for tool version endpoints.
 * Mounted at /api/v1 in app.ts; routes carry the full /tools/:id/versions path.
 * Accepts both session cookies and Bearer API keys via requireAnyAuth.
 */
export const toolVersionsRouter = Router();

// Commit a new immutable version — editor and above only
toolVersionsRouter.post('/tools/:id/versions', requireAnyAuth, requireRole('owner', 'admin', 'editor'), createToolVersionHandler);

// List all versions for a tool — any authenticated user
toolVersionsRouter.get('/tools/:id/versions', requireAnyAuth, listToolVersionsHandler);

// Fetch a specific version by its sequential number — any authenticated user
toolVersionsRouter.get('/tools/:id/versions/:version_number', requireAnyAuth, getToolVersionHandler);
