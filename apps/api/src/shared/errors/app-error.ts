/**
 * Where a failed operation was recorded, so the caller can open it (issue #638).
 * Every field is optional: the trace write is best-effort and may not have happened.
 */
export interface ErrorTraceRef {
  /** The trace the failure landed in. Sent to the client as `error.traceId`. */
  traceId?: string;
  /** The failed span's own ref, for `x-gateway-span-id`. */
  spanRef?: string;
  /** The `gateway_requests` row the failure was logged under, for `x-gateway-request-id`. */
  requestId?: string;
}

/**
 * Base class for all application-level errors.
 * Services throw subclasses of this; the global error handler maps
 * them to HTTP responses via `statusCode` and `code`.
 */
export class AppError extends Error {
  /** HTTP status code to send in the response. */
  public readonly statusCode: number;

  /**
   * Machine-readable error code included in the JSON response body.
   * Clients use this for programmatic error handling.
   */
  public readonly code: string;

  /**
   * Optional extra data attached to the error (e.g. missing variable names).
   * Only populated for specific error codes that need structured client output.
   */
  public readonly details?: Record<string, unknown>;

  /**
   * Where this failure was recorded, when it was (see {@link withTrace}). Unset for the
   * ordinary case of an error that wrote nothing.
   */
  public trace?: ErrorTraceRef;

  /**
   * @param message - Human-readable description (safe to send to clients).
   * @param statusCode - HTTP status code (e.g. 400, 401, 404).
   * @param code - Short all-caps code (e.g. 'VALIDATION_ERROR').
   * @param details - Optional extra data for structured error responses.
   */
  constructor(message: string, statusCode: number, code: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    // Maintains proper prototype chain in transpiled TypeScript
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Attaches the trace a failed call was recorded in. A gateway completion that fails at
   * the provider still writes an error trace; without this its 502 named no trace, so the
   * caller could not find the one call they most wanted to inspect (issue #638).
   *
   * @param trace - The recorded trace, span and request ids; any may be missing.
   * @returns This error, so the call site can `throw err.withTrace(...)`.
   */
  withTrace(trace: ErrorTraceRef): this {
    this.trace = trace;
    return this;
  }
}
