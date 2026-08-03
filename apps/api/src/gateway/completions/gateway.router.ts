import { Router, type IRouter } from 'express';
import { ConnectionsRepository } from '../connections/connections.repository';
import { GatewayRepository } from './gateway.repository';
import { GatewayService } from './gateway.service';
import { GatewayController } from './gateway.controller';
import { gatewayAuth } from '../keys/gateway-auth.middleware';

const gatewayRepo = new GatewayRepository();
const connectionsRepo = new ConnectionsRepository();
const service = new GatewayService(gatewayRepo, connectionsRepo);
const controller = new GatewayController(service);

/**
 * Router for the core gateway completion endpoint. Mounted at /api/v1/gateway in app.ts.
 * Auth is `gatewayAuth` (G3): a `agh_sk_` virtual key is the primary path, else it
 * falls back to session / personal-key auth requiring owner/admin/editor (FAQ Q9);
 * viewers get 403.
 */
export const gatewayCompletionsRouter: IRouter = Router();

gatewayCompletionsRouter.post('/chat/completions', gatewayAuth, controller.chatCompletion);
