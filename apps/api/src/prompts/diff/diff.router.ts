import { Router } from 'express';
import { requireAnyAuth, validateUuidParam } from '../../shared/middleware';
import { getDiff } from './diff.controller';

/**
 * Diff sub-router. Mounted at /api/v1 in app.ts.
 * Provides unified diff between any two prompt version numbers.
 */
export const diffRouter = Router();

diffRouter.get('/prompts/:id/versions/diff', requireAnyAuth, validateUuidParam('id'), getDiff);
