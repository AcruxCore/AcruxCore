import { Router, IRouter } from 'express';
import { DatasetsRepository } from './datasets.repository';
import { DatasetsService } from './datasets.service';
import { DatasetsController } from './datasets.controller';
import { requireAnyAuth, requireRole } from '../../shared/middleware';

const repo = new DatasetsRepository();
const service = new DatasetsService(repo);
const controller = new DatasetsController(service);

/**
 * Router for the datasets domain (Phase 5 E2): build-from-feedback plus plain
 * CRUD over datasets and their examples. Mounted under `/datasets` by
 * `evaluations.router.ts`.
 *
 * Reads are open to every member. Writes are `editor` and above, matching the
 * prompt version-commit route: a dataset is the material an evaluation is
 * measured against, so editing it is editing work. Ungated, `viewer` — the role
 * a team gives someone who should look and not touch — could delete the team's
 * datasets outright.
 */
export const datasetsRouter: IRouter = Router();

/** Every dataset mutation carries the same gate; named once so the list below stays readable. */
const canWrite = requireRole('owner', 'admin', 'editor');

// Static path first so it is never shadowed by /:id.
datasetsRouter.post('/from-feedback', requireAnyAuth, canWrite, controller.buildFromFeedback);
datasetsRouter.post('/', requireAnyAuth, canWrite, controller.create);
datasetsRouter.get('/', requireAnyAuth, controller.list);
datasetsRouter.get('/:id', requireAnyAuth, controller.get);
datasetsRouter.patch('/:id', requireAnyAuth, canWrite, controller.update);
datasetsRouter.delete('/:id', requireAnyAuth, canWrite, controller.remove);
// Before the generic `/:id/examples` POST for readability only — the paths have
// a different segment count, so Express never confuses the two.
datasetsRouter.post('/:id/examples/from-feedback', requireAnyAuth, canWrite, controller.addExamplesFromFeedback);
datasetsRouter.post('/:id/examples', requireAnyAuth, canWrite, controller.addExample);
datasetsRouter.patch('/:id/examples/:exampleId', requireAnyAuth, canWrite, controller.updateExample);
datasetsRouter.delete('/:id/examples/:exampleId', requireAnyAuth, canWrite, controller.removeExample);
