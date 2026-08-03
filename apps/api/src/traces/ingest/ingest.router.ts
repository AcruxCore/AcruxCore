import { Router, IRouter } from 'express';
import { SpansRepository } from '../spans';
import { TraceSettingsRepository } from '../settings';
import { requireAnyAuthOrVirtualKey } from '../../shared/middleware';
import { IngestService } from './ingest.service';
import { IngestController } from './ingest.controller';

const spans = new SpansRepository();
const settings = new TraceSettingsRepository();
const service = new IngestService(spans, settings);
const controller = new IngestController(service);

/**
 * Router for trace ingestion — `POST /traces`, mounted at `/api/v1` in app.ts
 * (a sibling of `tracesRouter`, not nested under it, per the T2 plan). Any
 * authenticated team member, a personal API key, or a virtual key may report
 * traces — {@link requireAnyAuthOrVirtualKey} applies no role gate.
 */
export const ingestRouter: IRouter = Router();

ingestRouter.post('/traces', requireAnyAuthOrVirtualKey, controller.ingest);
