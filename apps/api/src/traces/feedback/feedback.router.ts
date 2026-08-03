import { Router, IRouter } from 'express';
import { FeedbackRepository } from './feedback.repository';
import { FeedbackService } from './feedback.service';
import { FeedbackController } from './feedback.controller';
import { requireAnyAuth } from '../../shared/middleware';

const repo = new FeedbackRepository();
const service = new FeedbackService(repo);
const controller = new FeedbackController(service);

/**
 * Router for trace feedback. Both posting and reading are open to any member or
 * API key (spec Authorization matrix) — `requireAnyAuth`, no `requireRole`.
 * Mounted at /api/v1 in app.ts, BEFORE the T4 traces query router.
 */
export const feedbackRouter: IRouter = Router();

// Static paths first so they are never shadowed by /traces/:id in the T4 router.
feedbackRouter.get('/traces/feedback/summary', requireAnyAuth, controller.summary);
feedbackRouter.get('/traces/feedback', requireAnyAuth, controller.listAll);
feedbackRouter.post('/traces/:id/feedback', requireAnyAuth, controller.create);
feedbackRouter.get('/traces/:id/feedback', requireAnyAuth, controller.list);
feedbackRouter.patch('/traces/:id/feedback/:feedbackId', requireAnyAuth, controller.update);
