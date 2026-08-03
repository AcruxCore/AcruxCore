import { Router, type IRouter } from 'express';
import { VirtualKeysRepository } from './keys.repository';
import { VirtualKeysService } from './keys.service';
import { VirtualKeysController } from './keys.controller';
import { requireAnyAuth, requireRole } from '../../shared/middleware';

const repo = new VirtualKeysRepository();
const service = new VirtualKeysService(repo);
const controller = new VirtualKeysController(service);

/**
 * Virtual-key management routes. Mounted at `/api/v1/gateway` so paths resolve to
 * `/api/v1/gateway/keys`. Management (create/update/revoke) is owner/admin only;
 * listing (masked) is allowed for any role.
 */
export const virtualKeysRouter: IRouter = Router();

virtualKeysRouter.post('/keys', requireAnyAuth, requireRole('owner', 'admin'), controller.create);
virtualKeysRouter.get('/keys', requireAnyAuth, controller.list);
virtualKeysRouter.patch('/keys/:id', requireAnyAuth, requireRole('owner', 'admin'), controller.update);
virtualKeysRouter.delete('/keys/:id', requireAnyAuth, requireRole('owner', 'admin'), controller.revoke);
