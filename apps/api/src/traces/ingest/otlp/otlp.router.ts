import { Router, IRouter, json, raw } from 'express';
import { SpansRepository } from '../../spans';
import { TraceSettingsRepository } from '../../settings';
import { requireAnyAuthOrVirtualKey } from '../../../shared/middleware';
import { IngestService } from '../ingest.service';
import { OtlpService } from './otlp.service';
import { OtlpController } from './otlp.controller';

const spans = new SpansRepository();
const settings = new TraceSettingsRepository();
const ingestService = new IngestService(spans, settings);
const otlpService = new OtlpService(ingestService);
const controller = new OtlpController(otlpService);

/**
 * Router for the OTLP/HTTP trace receiver — `POST /traces/otlp`, mounted at
 * `/api/v1` in app.ts, a sibling of the native `POST /traces` JSON endpoint.
 *
 * This route parses its **own** body and is therefore mounted ahead of the
 * app-wide `express.json()`: that parser's 100KB default would 413 an ordinary
 * OTLP/JSON export long before the endpoint saw it, while the protobuf twin
 * accepted 10MB. Both parsers below are content-type-scoped and route-scoped, so
 * no other route's body handling changes. Both honor `Content-Encoding: gzip`
 * automatically (body-parser's `inflate` default), which is the default
 * compression for every OTel HTTP exporter.
 */
export const otlpRouter: IRouter = Router();

otlpRouter.post(
  '/traces/otlp',
  requireAnyAuthOrVirtualKey,
  raw({ type: 'application/x-protobuf', limit: '10mb' }),
  json({ type: 'application/json', limit: '10mb' }),
  controller.ingest,
);
