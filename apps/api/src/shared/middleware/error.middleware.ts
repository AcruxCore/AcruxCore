import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/app-error';

/**
 * Global Express error-handling middleware. Must be registered LAST in app.ts.
 *
 * - `AppError` subclasses are mapped to their `statusCode` and `code`.
 * - Unknown errors log the full stack server-side and return a generic 500.
 *   The stack trace is never sent to the client.
 *
 * @param err - The thrown error (may or may not be an AppError).
 */
export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  // next must be declared even if unused — Express identifies error handlers by arity
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message },
    });
    return;
  }

  // Unknown error — log full detail server-side, send nothing sensitive
  console.error('[unhandled error]', err);
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
  });
}
