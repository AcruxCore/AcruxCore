import { Router, IRouter } from 'express';
import { ExperimentsRepository } from '../experiments/experiments.repository';
import { DatasetsRepository } from '../datasets/datasets.repository';
import { RunsRepository } from './runs.repository';
import { PromptsRepository } from '../../prompts/prompts.repository';
import { AliasesRepository } from '../../prompts/aliases/aliases.repository';
import { AliasesService } from '../../prompts/aliases/aliases.service';
import { VersionsRepository } from '../../prompts/versions/versions.repository';
import { VersionsService } from '../../prompts/versions/versions.service';
import { OptimizeRepository, OptimizeService, OptimizeController } from '../optimize';
import { RunsService } from './runs.service';
import { RunsController } from './runs.controller';
import { requireAnyAuth, requireRole } from '../../shared/middleware';

const service = new RunsService(
  new ExperimentsRepository(),
  new DatasetsRepository(),
  new RunsRepository(),
  new PromptsRepository(),
  new AliasesRepository(),
  new VersionsRepository(),
);
const controller = new RunsController(service);

// `POST /runs/:id/promote` (E6 Task 5) is a distinct resource-action from
// the rest of this router's run-orchestration endpoints — it belongs to the
// optimize-loop domain (`OptimizeService.promoteCandidate`), not
// `RunsService`. Wired here (its own `OptimizeService`/`OptimizeController`
// instance, same construction pattern as `optimize.router.ts`) because the
// URL itself is `/runs/:id/promote`, and this file already owns the `/runs`
// resource root.
const promoteService = new OptimizeService(
  new ExperimentsRepository(),
  new DatasetsRepository(),
  new RunsRepository(),
  new PromptsRepository(),
  new OptimizeRepository(),
  new VersionsService(),
  new AliasesService(),
);
const promoteController = new OptimizeController(promoteService);

/**
 * Router for the run-orchestration endpoints (Phase 5 E3 Task 5). Carries
 * both full paths itself, rather than being mounted under a single prefix,
 * since it spans two resource roots — `POST /experiments/:id/runs` (nested
 * under the experiments resource) and `GET /runs/:id` (its own resource) —
 * mounted at the evaluations aggregator's root in `evaluations.router.ts`.
 * Requires any authenticated member or API key — `requireAnyAuth`, no role
 * restriction (any team member may start/read runs).
 */
export const runsRouter: IRouter = Router();

runsRouter.post('/experiments/:id/runs', requireAnyAuth, controller.startRun);
runsRouter.get('/runs/:id', requireAnyAuth, controller.getRun);
runsRouter.get('/runs/:id/report', requireAnyAuth, controller.getReport);
runsRouter.get('/runs/:id/cells/:cellKey', requireAnyAuth, controller.getCell);

// Read one optimizer-drafted candidate's template + rationale (E7 Task 5) —
// the promote-review UI's "what am I about to promote" read. Read-only, so
// unlike `/runs/:id/promote` below it needs only `requireAnyAuth`: viewing a
// candidate does not require promote-right, only actually promoting it does.
runsRouter.get('/runs/:id/candidates/:candidateId', requireAnyAuth, promoteController.getCandidate);

// Promote a winning optimizer-drafted candidate to a real version — editor
// and above only, same guard as the prompt-alias promote route and the
// version-commit route (`requireRole('owner', 'admin', 'editor')`).
runsRouter.post(
  '/runs/:id/promote',
  requireAnyAuth,
  requireRole('owner', 'admin', 'editor'),
  promoteController.promote,
);
