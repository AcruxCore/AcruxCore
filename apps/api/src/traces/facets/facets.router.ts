import { Router, type IRouter } from 'express';
import { requireAnyAuth } from '../../shared/middleware';
import { TraceFacetsRepository } from './facets.repository';
import { TraceFacetsService } from './facets.service';
import { TraceFacetsController } from './facets.controller';

const repo = new TraceFacetsRepository();
const service = new TraceFacetsService(repo);
const controller = new TraceFacetsController(service);

/**
 * Sub-router for trace facet discovery. Routes are declared on `/facets` (+
 * `/facets/values`) so it can be aggregated under `/api/v1/traces` by
 * `tracesRouter`, BEFORE `traceQueryRouter`'s `/traces/:id` — same static-route-
 * first ordering as `settingsRouter`/`analyticsRouter`. Read-only, any member.
 */
export const facetsRouter: IRouter = Router();

facetsRouter.get('/facets', requireAnyAuth, controller.getFacets);
facetsRouter.get('/facets/values', requireAnyAuth, controller.getMetadataValues);
