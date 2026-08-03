import { Router, IRouter } from 'express';
import { ConnectionsRepository } from './connections.repository';
import { ConnectionsService } from './connections.service';
import { ConnectionsController } from './connections.controller';
import { requireAnyAuth, requireRole } from '../../shared/middleware';

const repo = new ConnectionsRepository();
const service = new ConnectionsService(repo);
const controller = new ConnectionsController(service);

/**
 * Router for /api/v1/gateway/connections. Mutations require owner/admin; reads
 * allow any authenticated role. Mounted in app.ts.
 */
export const connectionsRouter: IRouter = Router();

connectionsRouter.post('/', requireAnyAuth, requireRole('owner', 'admin'), controller.create);
connectionsRouter.get('/', requireAnyAuth, controller.list);
connectionsRouter.get('/:id', requireAnyAuth, controller.get);
connectionsRouter.patch('/:id', requireAnyAuth, requireRole('owner', 'admin'), controller.update);
connectionsRouter.delete('/:id', requireAnyAuth, requireRole('owner', 'admin'), controller.remove);
