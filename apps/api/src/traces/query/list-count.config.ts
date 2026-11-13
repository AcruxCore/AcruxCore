import { positiveIntFromEnv } from '../../shared/env';

/** Default number of rows a trace list counts past the current page before it stops. */
export const DEFAULT_TRACE_LIST_COUNT_CAP = 10_000;

/**
 * How many matching traces past the current page a list request counts, read from
 * `TRACE_LIST_COUNT_CAP` on every call so an operator or a test can change it without a
 * restart. A full `COUNT(*)` grew with the team's history and was a third of the list
 * call's time at 100,000 traces (issue #851).
 *
 * @returns A positive integer; the default for an unset or invalid value.
 */
export function getTraceListCountCap(): number {
  return positiveIntFromEnv('TRACE_LIST_COUNT_CAP') ?? DEFAULT_TRACE_LIST_COUNT_CAP;
}
