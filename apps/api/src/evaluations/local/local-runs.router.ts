import { Router, IRouter } from 'express';
import { LocalRunsRepository } from './local-runs.repository';
import { LocalRunsService } from './local-runs.service';
import { LocalRunsController } from './local-runs.controller';
import { DatasetsRepository } from '../datasets/datasets.repository';
import { RunsService } from '../runs/runs.service';
import { ExperimentsRepository } from '../experiments/experiments.repository';
import { RunsRepository } from '../runs/runs.repository';
import { PromptsRepository } from '../../prompts/prompts.repository';
import { AliasesService } from '../../prompts/aliases/aliases.service';
import { VersionsRepository } from '../../prompts/versions/versions.repository';
import { MembersRepository } from '../../teams/members/members.repository';
import { requireAnyAuth, requireRole, validateUuidParam } from '../../shared/middleware';

const controller = new LocalRunsController(
  new LocalRunsService(new LocalRunsRepository(), new DatasetsRepository()),
  new RunsService(
    new ExperimentsRepository(),
    new DatasetsRepository(),
    new RunsRepository(),
    new PromptsRepository(),
    new AliasesService(),
    new VersionsRepository(),
    new MembersRepository(),
  ),
);

/**
 * Router for local experiments (phase-5 FAQ Q46): the three writes an SDK makes
 * while it runs the caller's own app and scorers. Like `runsRouter`, it carries
 * full paths because it spans the `/experiments` and `/runs` roots, and it is
 * mounted at the evaluations aggregator's root **before** `experimentsRouter`
 * would see `/experiments/local`.
 *
 * All are `editor` and above, the same gate as starting a server-side run:
 * they create runs and write results the whole team reads, and `judge` spends
 * judge calls under the team's budget (phase-5 FAQ Q59).
 */
export const localRunsRouter: IRouter = Router();

const editor = requireRole('owner', 'admin', 'editor');
localRunsRouter.post('/experiments/local', requireAnyAuth, editor, controller.create);
localRunsRouter.post('/runs/:id/results', requireAnyAuth, editor, controller.submitResults);
localRunsRouter.post('/runs/:id/finish', requireAnyAuth, editor, controller.finish);
// Checked here: the judge reads the run with a raw `::uuid` cast, whose failure
// would otherwise reach the error middleware as a 500.
localRunsRouter.post('/runs/:id/judge', requireAnyAuth, editor, validateUuidParam('id'), controller.judge);
