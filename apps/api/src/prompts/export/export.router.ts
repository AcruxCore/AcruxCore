import { Router } from 'express';
import { requireAnyAuth, validateUuidParam } from '../../shared/middleware';
import { exportVersion } from './export.controller';

/**
 * Export sub-router. Mounted at /api/v1 in app.ts.
 * Provides single-version portable JSON download.
 */
export const exportRouter = Router();

exportRouter.get(
  '/prompts/:id/versions/:version_number/export',
  requireAnyAuth,
  validateUuidParam('id'),
  exportVersion,
);
