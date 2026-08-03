import { Router, type IRouter } from 'express';
import { TraceSettingsRepository } from './settings.repository';
import { TraceSettingsService } from './settings.service';
import { TraceSettingsController } from './settings.controller';
import { requireAnyAuth, requireRole } from '../../shared/middleware';

const repo = new TraceSettingsRepository();
const service = new TraceSettingsService(repo);
const controller = new TraceSettingsController(service);

/**
 * Sub-router for the trace-settings endpoints. Routes are declared on `/settings`
 * so it can be aggregated under `/api/v1/traces` by the tracesRouter. GET allows
 * any member; PUT requires owner/admin.
 */
export const settingsRouter: IRouter = Router();

settingsRouter.get('/settings', requireAnyAuth, controller.get);
settingsRouter.put('/settings', requireAnyAuth, requireRole('owner', 'admin'), controller.update);
