import { Router, type IRouter } from 'express';
import { requireAnyAuth, requireRole } from '../../shared/middleware';
import { CacheService } from './cache.service';
import { CacheController } from './cache.controller';

const service = new CacheService();
const controller = new CacheController(service);

/**
 * Router for cache management. Mounted at /api/v1/gateway in app.ts.
 * Flushing is an owner/admin action (it discards paid-for cached results).
 */
export const cacheRouter: IRouter = Router();

cacheRouter.delete('/cache', requireAnyAuth, requireRole('owner', 'admin'), controller.flush);
