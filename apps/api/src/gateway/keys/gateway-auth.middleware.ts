import { Request, Response, NextFunction } from 'express';
import { requireAnyAuth, requireRole } from '../../shared/middleware';
import { AppError } from '../../shared/errors';
import { VirtualKeysRepository } from './keys.repository';
import { hashKey } from './keys.crypto';

const repo = new VirtualKeysRepository();

/**
 * Authenticates a caller for the gateway completion endpoint via one of two paths:
 *
 * 1. **Virtual key (primary):** `Authorization: Bearer agh_sk_…` is hashed and
 *    looked up; an active key builds a `GatewayCallContext` on `req.gateway`
 *    carrying the team, key id, scopes, and rate/cache limits. The key IS the
 *    grant (FAQ Q9) — no human-role check. Unknown/revoked → 401 `INVALID_KEY`.
 * 2. **Session / personal key (fallback):** delegates to `requireAnyAuth` then
 *    `requireRole('owner','admin','editor')` (spending money requires editor+),
 *    then builds an unrestricted `req.gateway` from the resolved session/user.
 *
 * @param req - Express request; `Authorization` header is inspected.
 * @param res - Express response (forwarded to fallback middlewares).
 * @param next - Express next; called on success or with the error on failure.
 * @throws {AppError} 401 `INVALID_KEY` when a virtual-key token does not resolve.
 * @throws {UnauthorizedError|ForbiddenError} From the fallback middlewares.
 */
export async function gatewayAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers['authorization'];
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;

  // ── Primary path: virtual key ────────────────────────────────────────────
  if (token?.startsWith('agh_sk_')) {
    try {
      const row = await repo.findActiveByHash(hashKey(token));
      if (!row) {
        throw new AppError('Invalid or revoked virtual key.', 401, 'INVALID_KEY');
      }
      req.teamId = row.teamId;
      req.gateway = {
        teamId: row.teamId,
        virtualKeyId: row.id,
        allowedModels: row.allowedModels.length > 0 ? row.allowedModels : null,
        allowedProviders: row.allowedProviders.length > 0 ? row.allowedProviders : null,
        maxRpm: row.maxRpm,
        maxTpm: row.maxTpm,
        cacheTtlSeconds: row.cacheTtlSeconds,
      };
      next();
    } catch (err) {
      next(err);
    }
    return;
  }

  // ── Fallback path: session / personal API key ─────────────────────────────
  requireAnyAuth(req, res, (authErr?: unknown) => {
    if (authErr) return next(authErr);
    requireRole('owner', 'admin', 'editor')(req, res, (roleErr?: unknown) => {
      if (roleErr) return next(roleErr);
      req.gateway = {
        teamId: req.teamId!,
        actorId: req.user?.id,
        allowedModels: null,
        allowedProviders: null,
        maxRpm: null,
        maxTpm: null,
        cacheTtlSeconds: null,
      };
      next();
    });
  });
}
