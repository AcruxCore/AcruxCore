import { Router, IRouter } from 'express';
import { SecretsRepository } from './secrets.repository';
import { SecretsService } from './secrets.service';
import { SecretsController } from './secrets.controller';
import { requireAnyAuth, requireRole } from '../shared/middleware';

const repo = new SecretsRepository();
const service = new SecretsService(repo);
const controller = new SecretsController(service);

/**
 * Router for /api/v1/secrets. Mutations require owner/admin; reads allow any
 * authenticated role. Mounted in app.ts.
 */
export const secretsRouter: IRouter = Router();

secretsRouter.post('/', requireAnyAuth, requireRole('owner', 'admin'), controller.create);
secretsRouter.get('/', requireAnyAuth, controller.list);
secretsRouter.put('/:id', requireAnyAuth, requireRole('owner', 'admin'), controller.rotate);
secretsRouter.delete('/:id', requireAnyAuth, requireRole('owner', 'admin'), controller.remove);
