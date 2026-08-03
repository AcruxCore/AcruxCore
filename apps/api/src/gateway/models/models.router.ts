import { Router, IRouter } from 'express';
import { ModelsRepository } from './models.repository';
import { ModelsService } from './models.service';
import { ModelsController } from './models.controller';
import { requireAnyAuth, requireRole } from '../../shared/middleware';

const repo = new ModelsRepository();
const service = new ModelsService(repo);
const controller = new ModelsController(service);

/**
 * Router for /api/v1/gateway/models. Mutations + Test require owner/admin; reads
 * allow any authenticated role. Mounted in app.ts.
 */
export const modelsRouter: IRouter = Router();

modelsRouter.post('/', requireAnyAuth, requireRole('owner', 'admin'), controller.create);
modelsRouter.get('/', requireAnyAuth, controller.list);
modelsRouter.get('/:id', requireAnyAuth, controller.get);
modelsRouter.patch('/:id', requireAnyAuth, requireRole('owner', 'admin'), controller.update);
modelsRouter.delete('/:id', requireAnyAuth, requireRole('owner', 'admin'), controller.remove);
modelsRouter.post('/:id/test', requireAnyAuth, requireRole('owner', 'admin'), controller.test);
