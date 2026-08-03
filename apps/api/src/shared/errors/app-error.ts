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
}
