import { Router, IRouter } from 'express';
import { ApiKeysRepository } from './api-keys.repository';
import { ApiKeysService } from './api-keys.service';
import { ApiKeysController } from './api-keys.controller';
import { requireAnyAuth, requireRole } from '../shared/middleware';

const repo = new ApiKeysRepository();
const service = new ApiKeysService(repo);
const controller = new ApiKeysController(service);

export const apiKeysRouter: IRouter = Router();

apiKeysRouter.post('/api-keys', requireAnyAuth, requireRole('owner', 'admin'), controller.create);
apiKeysRouter.get('/api-keys', requireAnyAuth, controller.list);
apiKeysRouter.delete('/api-keys/:id', requireAnyAuth, requireRole('owner', 'admin'), controller.revoke);
