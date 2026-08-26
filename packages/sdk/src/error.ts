import type { acruxcoreErrorCode } from './types';

/** How much of a server error message to carry into the thrown one. */
const MAX_SERVER_DETAIL = 400;

/**
 * A server's own `error.message`, formatted for appending to a thrown message.
 *
 * Both our API and every OpenAI-compatible provider answer errors as
 * `{ error: { message, ... } }`, and that message is where the actionable detail lives —
 * which tool, which alias, which model id. Truncated because a validation error can
 * carry a long list, and the full body is still on the error's `body` property either
 * way.
 *
 * Lives here rather than in `client.ts` because `client` imports `gateway-api`, so the
 * provider paths could not import it from there without a cycle.
 *
 * @param body - Parsed response body, or `undefined` when it was not JSON.
 * @returns `": <message>"`, or an empty string when there is nothing to add.
 */
export function serverDetail(body: unknown): string {
  const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
  if (typeof message !== 'string' || message.trim().length === 0) return '';
  const trimmed = message.trim();
  return `: ${trimmed.length > MAX_SERVER_DETAIL ? `${trimmed.slice(0, MAX_SERVER_DETAIL)}…` : trimmed}`;
}

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
