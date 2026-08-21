import { Router, IRouter } from 'express';
import { requireAnyAuth, requireRole } from '../../shared/middleware';
import { EvalRuleRepository } from './online-eval-rule.repository';
import { OnlineEvalRuleService } from './online-eval-rule.service';
import { OnlineEvalRuleController } from './online-eval-rule.controller';

const service = new OnlineEvalRuleService(new EvalRuleRepository());
const controller = new OnlineEvalRuleController(service);

/**
 * Routes for the online-eval-rule domain. Mounted at `/eval-rules` by the
 * evaluations aggregator, giving `/api/v1/eval-rules...` under `app.ts`.
 *
 * Mutations (create/update/delete/preview/to-dataset) are gated to
 * owner/admin, mirroring `gateway/budgets/budgets.router.ts`: `createRule`
 * writes `createdBy` from `req.user!.id`, which is `undefined` for a
 * team-scoped API key and would otherwise 500 instead of cleanly 403ing.
 * `preview` spends real judge/gateway money and `to-dataset` creates a
 * dataset, so both carry the same gate as create/update/delete. Read-only
 * routes (list/get/scores) stay ungated, matching `budgetsRouter.get`.
 */
export const evalRulesRouter: IRouter = Router();

evalRulesRouter.post('/', requireAnyAuth, requireRole('owner', 'admin'), controller.create);
evalRulesRouter.get('/', requireAnyAuth, controller.list);
evalRulesRouter.get('/:id', requireAnyAuth, controller.get);
evalRulesRouter.patch('/:id', requireAnyAuth, requireRole('owner', 'admin'), controller.update);
evalRulesRouter.delete('/:id', requireAnyAuth, requireRole('owner', 'admin'), controller.remove);
evalRulesRouter.get('/:id/scores', requireAnyAuth, controller.listScores);
evalRulesRouter.post('/:id/preview', requireAnyAuth, requireRole('owner', 'admin'), controller.preview);
evalRulesRouter.post('/:id/to-dataset', requireAnyAuth, requireRole('owner', 'admin'), controller.toDataset);
