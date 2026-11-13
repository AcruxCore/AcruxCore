import { Router } from 'express';
import { requireAnyAuth, requireRole, validateUuidParam } from '../../shared/middleware';
import {
  createVersionHandler,
  listVersionsHandler,
  getVersionHandler,
  getVersionByIdHandler,
  previewDraftHandler,
} from './versions.controller';

/**
 * Express router for prompt version endpoints.
 * Mounted at /api/v1 in app.ts; routes carry the full /prompts/:id/versions path.
 * Accepts both session cookies and Bearer API keys via requireAnyAuth.
 */
export const versionsRouter = Router();

// Commit a new immutable version — editor and above only
versionsRouter.post(
  '/prompts/:id/versions',
  requireAnyAuth,
  validateUuidParam('id'),
  requireRole('owner', 'admin', 'editor'),
  createVersionHandler,
);

// Render an unsaved draft in the sandbox for the Preview tab — any authenticated user, since
// every role can open the tab. Nothing is stored, so there is no write to gate.
versionsRouter.post('/prompts/:id/preview', requireAnyAuth, validateUuidParam('id'), previewDraftHandler);

// List all versions for a prompt — any authenticated user
versionsRouter.get('/prompts/:id/versions', requireAnyAuth, validateUuidParam('id'), listVersionsHandler);

// Fetch a specific version by its sequential number — any authenticated user
versionsRouter.get(
  '/prompts/:id/versions/:version_number',
  requireAnyAuth,
  validateUuidParam('id'),
  getVersionHandler,
);

// Resolve a version UUID → prompt + raw messages (Playground prefill) — any authenticated user
versionsRouter.get(
  '/prompt-versions/:versionId',
  requireAnyAuth,
  validateUuidParam('versionId'),
  getVersionByIdHandler,
);
