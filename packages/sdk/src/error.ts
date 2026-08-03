import type { acruxcoreErrorCode } from './types';

/**
 * Error thrown by acruxcore operations.
 * Always check `error.code` for the specific failure reason.
 * For MISSING_VARIABLES, `error.body.missing` contains the array of absent variable names.
 */
export class acruxcoreError extends Error {
  /** Machine-readable error code — use this for programmatic branching. */
  public readonly code: acruxcoreErrorCode;

  /**
   * HTTP status code from the API response, if this error originated from an HTTP call.
   * Undefined for MISSING_API_KEY, MISSING_BASE_URL, and NETWORK_ERROR.
   */
  public readonly statusCode?: number;

  /**
   * Parsed response body from the API, if available.
   * For MISSING_VARIABLES errors, `body` has shape `{ missing: string[] }`.
   */
  public readonly body?: unknown;

  /**
   * @param message - Human-readable description.
   * @param code - Machine-readable error code.
   * @param statusCode - HTTP status code, if applicable.
   * @param body - Parsed API response body, if applicable.
   */
  constructor(
    message: string,
    code: acruxcoreErrorCode,
    statusCode?: number,
    body?: unknown,
  ) {
    super(message);
    this.name = 'acruxcoreError';
    this.code = code;
    this.statusCode = statusCode;
    this.body = body;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
