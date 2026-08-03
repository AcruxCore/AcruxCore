import { Request, Response, NextFunction } from 'express';
import { requireAuth } from './require-auth.middleware';
import { requireApiKey } from './require-api-key.middleware';

/**
 * Accepts either a browser session cookie or an acruxcore API key
 * (`Authorization: Bearer acx_sk_…`), attaching `req.user` + `req.teamId`
 * identically for both.
 *
 * An `Authorization` header now means "API key", full stop. Under Supabase both
 * humans and SDKs arrived as `Bearer <value>` and the router had to *guess* which
 * was which by counting dot-separated segments (`looksLikeJwt`) — a heuristic that
 * silently misroutes any credential format that happens to have two dots. Moving
 * browsers to cookies removed the ambiguity rather than improving the guess.
 *
 * The header is checked first so an explicit API key always wins: a developer
 * curling with a key from a browser that happens to hold a session cookie gets
 * the key's team, not their own.
 *
 * @throws {UnauthorizedError} If neither path authenticates.
 */
export async function requireAnyAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return requireApiKey(req, res, next);
  }
  return requireAuth(req, res, next);
}
