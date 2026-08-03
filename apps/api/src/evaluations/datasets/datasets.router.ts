import { Router, IRouter } from 'express';
import { DatasetsRepository } from './datasets.repository';
import { DatasetsService } from './datasets.service';
import { DatasetsController } from './datasets.controller';
import { requireAnyAuth } from '../../shared/middleware';

const repo = new DatasetsRepository();
const service = new DatasetsService(repo);
const controller = new DatasetsController(service);

/**
 * Router for the datasets domain (Phase 5 E2): build-from-feedback plus plain
 * CRUD over datasets and their examples. All routes require any authenticated
 * member or API key — `requireAnyAuth`, no role restriction.
 * Mounted under `/datasets` by `evaluations.router.ts`.
 */
export const datasetsRouter: IRouter = Router();

// Static path first so it is never shadowed by /:id.
datasetsRouter.post('/from-feedback', requireAnyAuth, controller.buildFromFeedback);
datasetsRouter.post('/', requireAnyAuth, controller.create);
datasetsRouter.get('/', requireAnyAuth, controller.list);
datasetsRouter.get('/:id', requireAnyAuth, controller.get);
datasetsRouter.patch('/:id', requireAnyAuth, controller.update);
datasetsRouter.delete('/:id', requireAnyAuth, controller.remove);
datasetsRouter.post('/:id/examples', requireAnyAuth, controller.addExample);
datasetsRouter.delete('/:id/examples/:exampleId', requireAnyAuth, controller.removeExample);
