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
 * The writes carry two different bars, and the split is between a bounded
 * action and a standing one (issue #510).
 *
 * **Owner or admin** for create, update and delete. A rule judges live traffic
 * continuously, one judge call per sampled span, so turning one on changes what
 * the team is billed for from then on. That is a different decision from
 * spending a known amount once, and it mirrors `gateway/budgets`.
 *
 * **Editor and above** for `preview` and `to-dataset`. Preview judges at most
 * ten spans and ends; `to-dataset` copies rows the rule has already scored into
 * a dataset an editor could have built by hand. Both are smaller than the
 * experiment run an editor may already start, so holding them at owner/admin
 * read as a bug rather than a policy.
 *
 * Every write is gated, which also closes all of them to a team-scoped API key:
 * `requireRole` refuses a caller with no `req.user` before it looks at a role,
 * and these handlers read `req.user!.id` for `createdBy` and the audit actor.
 * Read-only routes (list/get/scores) stay ungated, matching `budgetsRouter.get`.
 *
 * `route-policy.test.ts` asserts each bar by name, so changing one here fails
 * there until the expectation is changed too — which is the point.
 */
export const evalRulesRouter: IRouter = Router();

/** Starts or stops a standing spend. */
const canOwnRule = requireRole('owner', 'admin');
/** A bounded, one-off action on a rule that already exists. */
const canUseRule = requireRole('owner', 'admin', 'editor');

evalRulesRouter.post('/', requireAnyAuth, canOwnRule, controller.create);
evalRulesRouter.get('/', requireAnyAuth, controller.list);
evalRulesRouter.get('/:id', requireAnyAuth, controller.get);
evalRulesRouter.patch('/:id', requireAnyAuth, canOwnRule, controller.update);
evalRulesRouter.delete('/:id', requireAnyAuth, canOwnRule, controller.remove);
evalRulesRouter.get('/:id/scores', requireAnyAuth, controller.listScores);
evalRulesRouter.post('/:id/preview', requireAnyAuth, canUseRule, controller.preview);
evalRulesRouter.post('/:id/to-dataset', requireAnyAuth, canUseRule, controller.toDataset);
