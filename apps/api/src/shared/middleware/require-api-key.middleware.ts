import { Request, Response, NextFunction } from 'express';
import { ApiKeysRepository } from '../../api-keys/api-keys.repository';
import { hashKey } from '../../api-keys/api-keys.crypto';
import { UnauthorizedError } from '../errors';

const repo = new ApiKeysRepository();

/**
 * Validates an `Authorization: Bearer <key>` header against the api_keys table.
 * Attaches `req.user` and `req.teamId` exactly as `requireAuth` does, so
 * downstream handlers are auth-method-agnostic.
 *
 * Only the sha256 hash of a key is stored, so the presented token is hashed and
 * looked up by hash. Revoked keys (`revoked_at IS NOT NULL`) are treated
 * identically to unknown keys to avoid leaking whether a key ever existed.
 *
 * @throws {UnauthorizedError} If the header is missing, malformed, or the key is unknown/revoked.
 */
export async function requireApiKey(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('API key required.');
    }

    const token = authHeader.slice(7).trim();
    const row = await repo.findActiveByHash(hashKey(token));

    if (!row) {
      throw new UnauthorizedError('Invalid or revoked API key.');
    }

    if (row.scope === 'team' || !row.userId || !row.user) {
      // Team-scoped key: no user identity. Downstream requireRole will block
      // member-management routes via req.user being undefined.
      req.user = undefined;
    } else {
      req.user = {
        id: row.userId,
        email: row.user.email,
        displayName: row.user.displayName,
      };
    }
    req.teamId = row.teamId;
    next();
  } catch (err) {
    next(err);
  }
}
