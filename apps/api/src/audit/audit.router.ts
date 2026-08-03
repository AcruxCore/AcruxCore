import { Router } from 'express';
import { requireAnyAuth } from '../shared/middleware';
import { listAuditEvents } from './audit.controller';

/**
 * Audit log router. Mounted at /api/v1 in app.ts.
 * Provides read-only access to the prompt-scoped audit trail.
 */
export const auditRouter = Router();

auditRouter.get('/prompts/:id/audit', requireAnyAuth, listAuditEvents);
