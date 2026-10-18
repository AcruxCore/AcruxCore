/**
 * An error returned by the AcruxCore REST API.
 *
 * The API's error envelope is `{ error: { code, message, ...details } }`. Everything
 * inside it is preserved: an MCP client's model can act on `MISSING_VARIABLES` plus the
 * `missing` array, or on `TOOL_NAME_TAKEN`, in a way it can never act on a bare
 * "request failed". `code` is the string the API sent, or a synthesised one
 * (`HTTP_<status>`) when a proxy returned a non-JSON body.
 */
export class AcruxCoreApiError extends Error {
  /** HTTP status of the failed response. `0` for a transport-level failure. */
  readonly status: number;

  /** AcruxCore error code, e.g. `NOT_FOUND`, `MISSING_VARIABLES`, `TOOL_NAME_TAKEN`. */
  readonly code: string;

  /** Any extra keys the error envelope carried beyond `code` and `message`. */
  readonly details: Record<string, unknown>;

  /** The request that failed, as `METHOD /path` — included in the message for context. */
  readonly request: string;

  /**
   * @param request - `METHOD /path` of the failed call.
   * @param status - HTTP status, or 0 when the request never completed.
   * @param code - AcruxCore error code.
   * @param message - Human-readable message, taken verbatim from the API when present.
   * @param details - Remaining keys from the error envelope.
   */
  constructor(
    request: string,
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AcruxCoreApiError';
    this.request = request;
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /**
   * Renders the error for an MCP tool result: code, status, message, and any details.
   *
   * Kept as one line per fact rather than a JSON blob because this text is what the
   * calling model reads to decide what to do next.
   *
   * @returns Multi-line text safe to put in a `CallToolResult` content block.
   */
  toToolText(): string {
    const lines = [
      `AcruxCore API error (${this.code})`,
      `Request: ${this.request}`,
      `Status: ${this.status}`,
      `Message: ${this.message}`,
    ];
    const detailKeys = Object.keys(this.details);
    if (detailKeys.length > 0) {
      lines.push(`Details: ${JSON.stringify(this.details)}`);
    }
    return lines.join('\n');
  }
}

/**
 * A configuration problem detected before any request is made — a missing API key, an
 * unknown toolset name. Separate from {@link AcruxCoreApiError} because it is fatal at
 * startup rather than per-call, and the stdio entry point exits on it.
 */
export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConfigError';
  }
}
