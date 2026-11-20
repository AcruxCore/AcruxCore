/**
 * The largest USD amount the `spans.cost_usd` and `traces.total_cost_usd` columns hold.
 * Both are `DECIMAL(18, 9)`: nine digits before the point, nine after.
 *
 * A reported span cost at or above 10^9 makes Postgres refuse the statement and fails the
 * request with a 500, so ingest drops such a cost as unreadable and the span is stored
 * (and priced from its tokens, when its model has a price) without it. The trace rollup,
 * a sum ingest computes itself, is capped at this value instead.
 */
export const MAX_COST_USD = '999999999.999999999';

/**
 * Reads a reported span cost as missing when it does not fit the cost column.
 *
 * @param value - A non-negative USD amount, or `undefined`.
 * @returns `value` when it is below 10^9, otherwise `undefined`. Every double below 10^9
 *   still rounds below it at nine decimals, so no accepted value can overflow.
 */
export function dropOversizedCost(value: number | undefined): number | undefined {
  return value !== undefined && value >= 1e9 ? undefined : value;
}
