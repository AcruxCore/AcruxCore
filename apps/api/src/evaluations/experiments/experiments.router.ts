import { Router, IRouter } from 'express';
import { ExperimentsRepository } from './experiments.repository';
import { ExperimentsService } from './experiments.service';
import { ExperimentsController } from './experiments.controller';
import { DatasetsRepository } from '../datasets/datasets.repository';
import { requireAnyAuth } from '../../shared/middleware';

const repo = new ExperimentsRepository();
const datasetsRepo = new DatasetsRepository();
const service = new ExperimentsService(repo, datasetsRepo);
const controller = new ExperimentsController(service);

/**
 * Router for the experiments domain (Phase 5 E3): create/list/get an
 * experiment (a dataset + prompt-version×model grid to sweep). Run-starting
 * endpoints are added in a later task. All routes require any authenticated
 * member or API key — `requireAnyAuth`, no role restriction. Mounted under
 * `/experiments` by `evaluations.router.ts`.
 */
export const experimentsRouter: IRouter = Router();

experimentsRouter.post('/', requireAnyAuth, controller.create);
experimentsRouter.get('/', requireAnyAuth, controller.list);
experimentsRouter.get('/:id', requireAnyAuth, controller.get);
