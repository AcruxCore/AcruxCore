import { Router } from 'express';
import { requireAnyAuth, requireRole } from '../../shared/middleware';
import { importPrompt } from './import.controller';

/**
 * Import router. Mounted at /api/v1 in app.ts.
 * Must be mounted BEFORE any router that uses /prompts/:id so that Express
 * does not match the literal string "import" as a prompt ID.
 */
export const importRouter = Router();

importRouter.post('/prompts/import', requireAnyAuth, requireRole('owner', 'admin', 'editor'), importPrompt);
