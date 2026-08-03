import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../errors';

const uuidSchema = z.string().uuid();

/**
 * Middleware factory that rejects a route with a malformed UUID path param
 * before it reaches a repository's Postgres query. Without this, a non-UUID
 * value (e.g. a resource name passed where an id is expected) reaches Prisma's
 * `WHERE id = $1` and Postgres throws an `invalid input syntax for type uuid`
 * error that the global error middleware can only map to a generic 500 —
 * this turns that into a clear 400 instead.
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
