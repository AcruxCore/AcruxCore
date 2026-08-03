import { Request, Response, NextFunction } from 'express';
import { requireAnyAuth } from './require-any-auth.middleware';
import { AppError } from '../errors';
import { VirtualKeysRepository } from '../../gateway/keys/keys.repository';
import { hashKey } from '../../gateway/keys/keys.crypto';

const virtualKeys = new VirtualKeysRepository();

/**
 * Authenticates a trace-ingestion caller via one of three grants, in order:
 *
 * 1. **Virtual key** — `Authorization: Bearer agh_sk_…` is hashed and looked up;
 *    an active key sets `req.teamId` to its team. The key IS the grant (no role
 *    check). Unknown/revoked → 401 `INVALID_KEY`.
 * 2. **Personal API key** or **3. Browser session** — anything not prefixed
 *    `agh_sk_` delegates to {@link requireAnyAuth}, which sets `req.teamId` from
 *    the `api_keys` row (SDK) or the session cookie (browser). **No `requireRole`**
 *    — any team member (including viewers) may report traces (not a money action).
 *
 * @param req - Express request; the `Authorization` header is inspected.
 * @param res - Express response (forwarded to the fallback middleware).
 * @param next - Called on success, or with the error on failure.
 * @throws {AppError} 401 `INVALID_KEY` when a virtual-key token does not resolve.
 * @throws {UnauthorizedError} From the fallback when no session/key is valid.
 */
export async function requireAnyAuthOrVirtualKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers['authorization'];
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;

  if (token?.startsWith('agh_sk_')) {
    try {
      const row = await virtualKeys.findActiveByHash(hashKey(token));
      if (!row) {
        throw new AppError('Invalid or revoked virtual key.', 401, 'INVALID_KEY');
      }
      req.teamId = row.teamId;
      next();
    } catch (err) {
      next(err);
    }
    return;
  }

  return requireAnyAuth(req, res, next);
}
