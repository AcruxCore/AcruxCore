/**
 * The hint under each price field in the model dialog. The gateway logs a null cost
 * when either price is missing, so one blank field zeroes the whole call.
 */
export const PRICE_FIELD_HINT = 'Blank = auto for known models. If either price is unknown, the whole call counts as $0.';

// Formats a nullable per-1M price for display.
function price(n: number | null): string {
  return n == null ? '—' : `$${n}`;
}

/**
 * The price line under a registered model on the Models page, plus a warning when the
 * gateway cannot cost its calls.
 *
 * The gateway logs a null cost when *either* price is missing (`computeCostFromPrices`
 * in apps/api), and Usage and budgets add a null cost as $0. So one missing price
 * zeroes the whole call, not only the missing side, and the warning says so.
 *
 * @param inputPricePerM - USD per million input tokens, or null when unknown.
 * @param outputPricePerM - USD per million output tokens, or null when unknown.
 * @returns `text`, the short price line, and `warning`, a full sentence to show on its
 *   own line (it must not be truncated), or null when both prices are set.
 */
export function modelPriceText(
  inputPricePerM: number | null,
  outputPricePerM: number | null,
): { text: string; warning: string | null } {
  if (inputPricePerM == null && outputPricePerM == null) {
    return { text: 'no price set', warning: 'Calls through this model are counted as $0 in Usage and budgets.' };
  }
  const text = `in ${price(inputPricePerM)} / out ${price(outputPricePerM)} per 1M`;
  if (inputPricePerM != null && outputPricePerM != null) return { text, warning: null };
  const [missing, other] = inputPricePerM == null ? ['input', 'output'] : ['output', 'input'];
  return {
    text,
    warning: `No ${missing} price set, so calls through this model are counted as $0 in Usage and budgets — ${other} tokens included.`,
  };
}
