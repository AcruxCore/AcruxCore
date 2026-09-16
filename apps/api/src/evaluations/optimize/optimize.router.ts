import { Router, IRouter } from 'express';
import { ExperimentsRepository } from '../experiments/experiments.repository';
import { DatasetsRepository } from '../datasets/datasets.repository';
import { RunsRepository } from '../runs/runs.repository';
import { PromptsRepository } from '../../prompts/prompts.repository';
import { OptimizeRepository } from './optimize.repository';
import { VersionsService } from '../../prompts/versions/versions.service';
import { AliasesService } from '../../prompts/aliases/aliases.service';
import { OptimizeService } from './optimize.service';
import { OptimizeController } from './optimize.controller';
import { requireAnyAuth, requireRole } from '../../shared/middleware';

const service = new OptimizeService(
  new ExperimentsRepository(),
  new DatasetsRepository(),
  new RunsRepository(),
  new PromptsRepository(),
  new OptimizeRepository(),
  new VersionsService(),
  new AliasesService(),
);
const controller = new OptimizeController(service);

/**
 * Router for the optimize-loop kickoff endpoint (Phase 5 E6 Task 3). Carries
 * its own `:promptId` param (not `:id`, to avoid confusion with
 * `aliasesRouter`/`renderRouter`, which are mounted at the same
 * `/api/v1/prompts` prefix but as separate router instances — no collision,
 * since each router only matches its own route patterns). Mounted under
 * `/prompts` by `evaluations.router.ts`.
 *
 * `editor` and above: an optimize run pays for an optimizer completion and then
 * a whole grid on top of it, which is the most expensive single thing a team
 * member can start. Same gate as `POST /runs/:id/promote`, the other half of
 * this loop.
 */
export const optimizeRouter: IRouter = Router();

optimizeRouter.post(
  '/:promptId/optimize',
  requireAnyAuth,
  requireRole('owner', 'admin', 'editor'),
  controller.start,
);
