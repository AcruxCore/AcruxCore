import { AppError } from './app-error';

/**
 * 400 — Request body or query params failed Zod validation.
 * Pass the Zod issue message as `message`.
 */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

/**
 * 401 — Caller is not authenticated, or credentials are invalid.
 * Use the same generic message whether it's "no session" or "wrong password"
 * to avoid leaking which factor failed.
 */
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required.') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

/**
 * 403 — Caller is authenticated but lacks the required role for this action.
 * Can be called as `new ForbiddenError(message)` or `new ForbiddenError(code, message)`.
 */
export class ForbiddenError extends AppError {
  constructor(codeOrMessage = 'Insufficient permissions.', message?: string) {
    if (message === undefined) {
      super(codeOrMessage, 403, 'FORBIDDEN');
    } else {
      super(message, 403, codeOrMessage);
    }
  }
}

/**
 * 404 — Resource not found, or found but not accessible to the caller.
 * Use the same message for both cases to avoid leaking existence of private resources.
 */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found.') {
    super(message, 404, 'NOT_FOUND');
  }
}

/**
 * 409 — Duplicate resource or conflicting state.
 * Can be called as `new ConflictError(message)` or `new ConflictError(code, message)`.
 */
export class ConflictError extends AppError {
  constructor(codeOrMessage: string, message?: string) {
    if (message === undefined) {
      super(codeOrMessage, 409, 'CONFLICT');
    } else {
      super(message, 409, codeOrMessage);
    }
  }
}

/**
 * 410 — Resource existed but is no longer available (e.g. expired invite token).
 */
export class GoneError extends AppError {
  constructor(code: string, message: string) {
    super(message, 410, code);
  }
}

/**
 * 402 — Caller is out of money (budget cap reached). Introduced in G2, enforced in G4.
 * Call as `new PaymentRequiredError(message)` or `new PaymentRequiredError(code, message)`.
 */
export class PaymentRequiredError extends AppError {
  constructor(codeOrMessage = 'Payment required.', message?: string) {
    if (message === undefined) super(codeOrMessage, 402, 'PAYMENT_REQUIRED');
    else super(message, 402, codeOrMessage);
  }
}

/**
 * 429 — Rate limit (RPM/TPM) exceeded. Introduced in G2, enforced in G4.
 * `retryAfter` (seconds) is read by the controller to set the `Retry-After` header.
 */
export class RateLimitedError extends AppError {
  constructor(message = 'Rate limit exceeded.', public readonly retryAfter?: number) {
    super(message, 429, 'RATE_LIMITED');
  }
}

/**
 * 502 — Upstream provider returned an error we surface to the caller.
 * Call as `new BadGatewayError(message)` or `new BadGatewayError(code, message)`.
 */
export class BadGatewayError extends AppError {
  constructor(codeOrMessage = 'Upstream provider error.', message?: string) {
    if (message === undefined) super(codeOrMessage, 502, 'PROVIDER_ERROR');
    else super(message, 502, codeOrMessage);
  }
}

/**
 * 504 — Upstream provider call timed out before responding.
 */
export class GatewayTimeoutError extends AppError {
  constructor(message = 'Upstream provider timed out.') {
    super(message, 504, 'PROVIDER_TIMEOUT');
  }
}

/**
 * 413 — The request batch is larger than the endpoint accepts (e.g. more than
 * the per-request span cap on trace ingestion). A Phase-3 guard, not silent —
 * callers log the offending count before throwing.
 */
export class PayloadTooLargeError extends AppError {
  constructor(message = 'Payload too large.') {
    super(message, 413, 'PAYLOAD_TOO_LARGE');
  }
}

/**
 * 422 — Request was well-formed but semantically unprocessable (e.g. building
 * a dataset from feedback rows that yield zero eligible examples). Distinct
 * from 400 `ValidationError`, which is for malformed request shape.
 */
export class UnprocessableError extends AppError {
  constructor(message = 'Request could not be processed.') {
    super(message, 422, 'UNPROCESSABLE');
  }
}
