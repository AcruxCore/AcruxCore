import { Router, type IRouter } from 'express';
import { BudgetsRepository } from './budgets.repository';
import { BudgetsService } from './budgets.service';
import { BudgetsController } from './budgets.controller';
import { requireAnyAuth, requireRole } from '../../shared/middleware';

const repo = new BudgetsRepository();
const service = new BudgetsService(repo);
const controller = new BudgetsController(service);

/** Router for /api/v1/gateway/budgets. Mutations owner/admin; list any role. */
export const budgetsRouter: IRouter = Router();

budgetsRouter.post('/', requireAnyAuth, requireRole('owner', 'admin'), controller.create);
budgetsRouter.get('/', requireAnyAuth, controller.list);
budgetsRouter.patch('/:id', requireAnyAuth, requireRole('owner', 'admin'), controller.update);
budgetsRouter.delete('/:id', requireAnyAuth, requireRole('owner', 'admin'), controller.remove);
