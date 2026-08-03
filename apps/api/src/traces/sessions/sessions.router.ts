import { Router, type IRouter } from 'express';
import { requireAnyAuth } from '../../shared/middleware';
import { SessionsRepository } from './sessions.repository';
import { SessionsService } from './sessions.service';
import { SessionsController } from './sessions.controller';

const repo = new SessionsRepository();
const service = new SessionsService(repo);
const ctrl = new SessionsController(service);

/**
 * Router for the sessions read surface. Mounted at /api/v1/sessions in app.ts.
 * Both routes are read-only and any-role (requireAnyAuth, no requireRole).
 */
export const sessionsRouter: IRouter = Router();

sessionsRouter.get('/', requireAnyAuth, ctrl.listSessions);
sessionsRouter.get('/:id', requireAnyAuth, ctrl.getSession);
