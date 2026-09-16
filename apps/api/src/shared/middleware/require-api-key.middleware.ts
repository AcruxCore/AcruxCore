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
 * A *personal* key additionally re-checks that its owner is still a member of the
 * key's team on every request. `api_keys.team_id` is denormalized, and nothing
 * revoked a personal key when its owner was removed from the team, so a removed
 * member's key kept naming that team and kept reading the team's data
 * indefinitely — while their browser session was correctly cut off by
 * `resolveActiveTeam`. The membership check lived on the session path only; this
 * puts it on both. A *team*-scoped key has no owner to check and is unaffected.
 *
 * The membership arrives with the key lookup itself rather than as a second query:
 * `findActiveByHash` joins it. The role it returns is also stashed on `req.teamRole`,
 * so `requireRole` does not have to read the same row a third time on the ~50
 * role-gated routes.
 *
 * @throws {UnauthorizedError} If the header is missing, malformed, the key is
 *   unknown or revoked, or a personal key's owner is no longer in the key's team.
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
      // Same message as an unknown key: a removed member must not be able to tell
      // "your key was cancelled" from "that team no longer exists".
      if (!row.membershipRole) {
        throw new UnauthorizedError('Invalid or revoked API key.');
      }

      req.user = {
        id: row.userId,
        email: row.user.email,
        displayName: row.user.displayName,
      };
      req.teamRole = row.membershipRole;
    }
    req.teamId = row.teamId;
    req.authMethod = 'api_key';
    next();
  } catch (err) {
    next(err);
  }
}
