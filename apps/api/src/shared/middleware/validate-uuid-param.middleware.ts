import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../errors';

const uuidSchema = z.string().uuid();

/**
 * Middleware factory that rejects a route with a malformed UUID path param
 * before it reaches a repository's Postgres query.
 *
 * `errorMiddleware` is the backstop: it maps Prisma's `P2023` to the same 400
 * `VALIDATION_ERROR`, so a route without this middleware is no longer answered with
 * a 500. Keeping this in front of the routes that have it is still worth a line of
 * wiring — it costs no database round trip, and its message names the offending
 * param (`id must be a valid UUID.`) where the backstop can only say that some
 * supplied value was malformed, because by then the failure is a driver error with
 * no idea which param it came from.
 *
 * @param paramName - The route param to validate (e.g. `'id'`).
 * @returns Express middleware that calls `next()` when the param is a valid
 *   UUID, or `next(ValidationError)` otherwise.
 * @throws {ValidationError} When `req.params[paramName]` is missing or not a UUID.
 */
export function validateUuidParam(paramName: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const value = req.params[paramName];
    if (!uuidSchema.safeParse(value).success) {
      next(new ValidationError(`${paramName} must be a valid UUID.`));
      return;
    }
    next();
  };
}
