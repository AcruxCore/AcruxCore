/** Decimal places kept in `x-gateway-cost-usd`. Real per-call costs go down to ~1e-7 USD. */
const COST_HEADER_DECIMALS = 10;

/**
 * Formats a call's cost for the `x-gateway-cost-usd` header.
 *
 * `String(number)` prints every significant digit of a float64, so a cost that is not
 * exact in binary came out as `0.00005909999999999999` (issue #422). Ten decimal places
 * keep sub-cent precision for the cheapest models — `toFixed(2)` would round a real
 * charge to zero — and trailing zeros are trimmed so `0` stays `0`, not `0.0000000000`.
 * The stored `gateway_requests.cost_usd` is not touched; this is display only.
 *
 * @param costUsd - The computed cost, or `null` when the model has no prices.
 * @returns The header value; an empty string for an unpriced call, as before.
 */
export function formatCostHeader(costUsd: number | null): string {
  if (costUsd === null) return '';
  return costUsd.toFixed(COST_HEADER_DECIMALS).replace(/\.?0+$/, '');
}
