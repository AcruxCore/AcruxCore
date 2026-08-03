import { Router, type IRouter } from 'express';
import { NotificationsRepository } from '../../notifications/notifications.repository';
import { NotificationsService } from '../../notifications/notifications.service';
import { UnsubscribeController } from './unsubscribe.controller';

const service = new NotificationsService(new NotificationsRepository());
const controller = new UnsubscribeController(service);

/**
 * Router for the unsubscribe endpoints, mounted at `/api/v1/email`.
 *
 * No auth middleware, on purpose — see {@link UnsubscribeController}. The signed
 * token in the query string is the only credential, and it authorizes exactly one
 * action: turning one category off for one user in one team.
 */
export const unsubscribeRouter: IRouter = Router();

unsubscribeRouter.post('/unsubscribe', controller.post);
unsubscribeRouter.get('/unsubscribe', controller.get);
