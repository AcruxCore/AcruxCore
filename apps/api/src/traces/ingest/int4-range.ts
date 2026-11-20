/**
 * The largest value a Postgres `integer` (INT4) column holds: 2^31 - 1.
 *
 * Every count and duration a span stores (`prompt_tokens`, `completion_tokens`,
 * `total_tokens`, `cached_tokens`, `latency_ms`) and the trace's `total_tokens` rollup are
 * INT4. A value past this makes Postgres refuse the whole statement, and since one
 * statement writes every span of a trace, one bad count used to fail the request with a
 * 500 (issue #843). Ingest therefore drops a reported value above this as unreadable, and
 * caps a sum it computes itself (a derived span total, the trace rollup) at this value.
 */
export const INT4_MAX = 2_147_483_647;

/**
 * Reads a reported integer as missing when it does not fit an INT4 column.
 *
 * @param value - A non-negative integer, or `undefined`.
 * @returns `value` when it is at most {@link INT4_MAX}, otherwise `undefined`.
 */
export function dropAboveInt4(value: number | undefined): number | undefined {
  return value !== undefined && value > INT4_MAX ? undefined : value;
}
