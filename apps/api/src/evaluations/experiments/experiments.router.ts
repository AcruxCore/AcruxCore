import { Router, IRouter } from 'express';
import { ExperimentsRepository } from './experiments.repository';
import { ExperimentsService } from './experiments.service';
import { ExperimentsController } from './experiments.controller';
import { DatasetsRepository } from '../datasets/datasets.repository';
import { requireAnyAuth, requireRole } from '../../shared/middleware';

const repo = new ExperimentsRepository();
const datasetsRepo = new DatasetsRepository();
const service = new ExperimentsService(repo, datasetsRepo);
const controller = new ExperimentsController(service);

/**
 * Router for the experiments domain (Phase 5 E3): create/list/get an
 * experiment (a dataset + prompt-version×model grid to sweep). Mounted under
 * `/experiments` by `evaluations.router.ts`.
 *
 * Reads are open to every member; creating or deleting an experiment is
 * `editor` and above. An experiment is the grid a run executes, one paid
 * provider call per cell, so defining it is not a read-only act.
 */
export const experimentsRouter: IRouter = Router();

experimentsRouter.post('/', requireAnyAuth, requireRole('owner', 'admin', 'editor'), controller.create);
experimentsRouter.get('/', requireAnyAuth, controller.list);
experimentsRouter.get('/:id', requireAnyAuth, controller.get);
experimentsRouter.delete('/:id', requireAnyAuth, requireRole('owner', 'admin', 'editor'), controller.remove);
