/**
 * How a tool tells the platform that a call went wrong, when only the tool can know.
 *
 * An HTTP 200 carrying `{"error": "location not found"}` is a successful request and a
 * failed tool call, and nothing outside the tool's own code can tell those apart. Before
 * this existed, such a call produced a green span and the model answered on top of the
 * error body — the whole of issue #452.
 *
 * Two alternatives were rejected. Injecting a context argument into the handler would
 * change its signature, and the schema a declared tool advertises to the model is derived
 * from that signature — so the model would start seeing a `ctx` parameter. A dedicated
 * non-fatal exception ends control flow, which is exactly what a tool reporting a handled
 * failure does not want: it still has something to hand back.
 *
 * The sentinel is inert to anyone who ignores it. A handler that returns a plain value
 * behaves exactly as before.
 */

/** Brand key. A symbol rather than a string, so a tool returning real data cannot collide. */
const TOOL_OUTCOME = Symbol.for('acruxcore.toolOutcome');

/** Whether a classified outcome is a failure or just something worth seeing. */
export type ToolOutcomeLevel = 'error' | 'warning';

/** A return value carrying the tool owner's own verdict alongside the result. */
export interface ToolOutcome {
  [TOOL_OUTCOME]: true;
  level: ToolOutcomeLevel;
  /** Short stable slug, e.g. `location_not_found`. Becomes the span's `errorType` detail. */
  type: string;
  /** Free text for whoever reads the span. */
  message: string;
  /** What the model still sees. Defaults to `{ error: message }` when omitted. */
  result: unknown;
}

/**
 * Marks this call a failure while still returning something to the model.
 *
 * The span turns red with `errorType: 'tool_declared'`, the loop keeps going, and the
 * model reads `result`. Use it for the case the transport and the HTTP status both call
 * a success and only your code knows otherwise.
 *
 * @param type - Short stable slug identifying the failure, e.g. `location_not_found`.
 * @param message - Human-readable detail, shown on the span.
 * @param result - What to hand the model. Defaults to `{ error: message }`.
 * @returns A branded outcome the tool loop unwraps; harmless if returned anywhere else.
 */
export function toolError(type: string, message: string, result?: unknown): ToolOutcome {
  return {
    [TOOL_OUTCOME]: true,
    level: 'error',
    type,
    message,
    result: result === undefined ? { error: message } : result,
  };
}

/**
 * Flags something worth seeing without calling the run failed — stale cache, a partial
 * result, a fallback data source.
 *
 * The span stays `ok` and gains a `warning` attribute, which `has_warning:` filters on.
 * Deliberately not a span status: a warning is not a verdict about whether the run
 * succeeded, and making it one would force every consumer of `span_status` to grow a
 * precedence rule.
 *
 * @param type - Short stable slug, e.g. `stale_data`.
 * @param message - Human-readable detail, shown on the span.
 * @param result - What to hand the model. Defaults to `{ warning: message }`.
 * @returns A branded outcome the tool loop unwraps; harmless if returned anywhere else.
 */
export function toolWarning(type: string, message: string, result?: unknown): ToolOutcome {
  return {
    [TOOL_OUTCOME]: true,
    level: 'warning',
    type,
    message,
    result: result === undefined ? { warning: message } : result,
  };
}

/**
 * Narrows an arbitrary handler return value to a {@link ToolOutcome}.
 *
 * @param value - Whatever the tool returned.
 * @returns `true` when it came from {@link toolError} or {@link toolWarning}.
 */
export function isToolOutcome(value: unknown): value is ToolOutcome {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[TOOL_OUTCOME] === true
  );
}
