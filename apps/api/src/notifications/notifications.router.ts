import { Router, type IRouter } from 'express';
import { NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import { requireAnyAuth, requireRole } from '../shared/middleware';

const repo = new NotificationsRepository();
const service = new NotificationsService(repo);
const controller = new NotificationsController(service);

/**
 * Router for notification preferences, mounted at `/api/v1/notifications`.
 *
 * `requireRole` with every member role is doing two jobs here: it rejects
 * team-scoped API keys (which have no `req.user`, so there is no "own
 * preferences" to read or write), and it confirms the caller is actually a
 * member of `req.teamId` before a row is created against that team.
 */
export const notificationsRouter: IRouter = Router();

const anyMember = requireRole('owner', 'admin', 'editor', 'viewer');

notificationsRouter.get('/preferences', requireAnyAuth, anyMember, controller.get);
notificationsRouter.patch('/preferences', requireAnyAuth, anyMember, controller.update);
