import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/app-error';

/** The status and error code we answer a given `body-parser` failure with. */
interface BodyParserFailure {
  status: number;
  code: string;
  message: string;
}

/**
 * `body-parser` failure `type` → the response it earns.
 *
 * `express.json()` rejects a bad request by throwing an `http-errors` object
 * rather than an {@link AppError}, so before this table every one of these fell
 * through to the generic 500 branch below. That told a client the server had
 * broken when in fact its own request was malformed, invited the retry-on-5xx
 * that every HTTP client does by default, and logged a client fault as if it
 * were worth paging on.
 *
 * The messages are fixed strings on purpose: `body-parser` puts a fragment of
 * the offending payload in `err.message`, which must not travel back to the
 * caller.
 */
const BODY_PARSER_FAILURES: Record<string, BodyParserFailure> = {
  'entity.parse.failed': {
    status: 400,
    code: 'INVALID_JSON',
    message: 'Request body is not valid JSON.',
  },
  'entity.too.large': {
    status: 413,
    code: 'PAYLOAD_TOO_LARGE',
    message: 'Request body is too large.',
  },
  'encoding.unsupported': {
    status: 415,
    code: 'UNSUPPORTED_ENCODING',
    message: 'Request body uses an unsupported Content-Encoding.',
  },
};

/**
 * Narrows an unknown error to a `body-parser` rejection.
 *
 * The `type` string is the discriminator: `http-errors` objects raised by
 * `body-parser` always carry one, and nothing we throw ourselves does. `status`
 * and `statusCode` are set to the same value, so either is read.
 *
 * @param err - The thrown error.
 * @returns The failure's `type` and status, or `undefined` if `err` is not a
 *   `body-parser` rejection.
 */
function asBodyParserError(err: unknown): { type: string; status?: number } | undefined {
  if (typeof err !== 'object' || err === null) return undefined;

  const candidate = err as { type?: unknown; status?: unknown; statusCode?: unknown };
  if (typeof candidate.type !== 'string') return undefined;

  const status =
    typeof candidate.status === 'number'
      ? candidate.status
      : typeof candidate.statusCode === 'number'
        ? candidate.statusCode
        : undefined;

  return { type: candidate.type, status };
}

/**
 * Global Express error-handling middleware. Must be registered LAST in app.ts.
 *
 * - `AppError` subclasses are mapped to their `statusCode` and `code`.
 * - `body-parser` rejections become the 4xx they are — see
 *   {@link BODY_PARSER_FAILURES}. They are client faults, so they are not
 *   logged, matching the `AppError` branch.
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

  const parserError = asBodyParserError(err);
  if (parserError) {
    const known = BODY_PARSER_FAILURES[parserError.type];
    if (known) {
      res.status(known.status).json({
        error: { code: known.code, message: known.message },
      });
      return;
    }

    // A `body-parser` failure we have no specific code for. Any 4xx it names is
    // still a truer answer than 500, so honour it rather than adding this
    // request to the unhandled pile. 5xx types (a stream that was never
    // readable, say) genuinely are our fault and fall through below.
    if (parserError.status !== undefined && parserError.status >= 400 && parserError.status < 500) {
      res.status(parserError.status).json({
        error: { code: 'BAD_REQUEST', message: 'Request could not be processed as sent.' },
      });
      return;
    }
  }

  // Unknown error — log full detail server-side, send nothing sensitive
  console.error('[unhandled error]', err);
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
  });
}
