import type { ListedProviderModel } from '@/api';

/** The three price fields of the model dialog, as the text each input holds. */
export interface PriceTexts {
  input: string;
  output: string;
  cached: string;
}

/**
 * A listed model's prices as form text, or null when the provider's list states none.
 *
 * @param pricing - The `pricing` of one entry from `GET /gateway/connections/:id/models`.
 * @returns The three fields; `cached` is '' when the list has no cache-read price, which
 *   leaves the gateway's default cache rate in place.
 */
export function pricesFromListing(pricing: ListedProviderModel['pricing']): PriceTexts | null {
  if (!pricing) return null;
  return {
    input: String(pricing.inputPricePerM),
    output: String(pricing.outputPricePerM),
    cached: pricing.cachedInputPricePerM != null ? String(pricing.cachedInputPricePerM) : '',
  };
}

/**
 * One price field's text after the user picks another upstream model.
 *
 * The field takes the new pick's price only while it is blank or still holds the price
 * filled in automatically for the previous pick, so a price the user typed is never
 * overwritten. A pick with no listed price clears a field that still holds a filled-in
 * price, so the old model's price is not saved against the new one.
 *
 * @param field - Which of the three fields.
 * @param current - What the field holds now.
 * @param previous - The prices last filled in automatically (copied from the list, or a
 *   model's saved prices when it was opened for editing), or null if none were.
 * @param next - The prices to fill in for the new pick, or null when there are none.
 * @returns The text the field should hold.
 */
export function copiedPrice(field: keyof PriceTexts, current: string, previous: PriceTexts | null, next: PriceTexts | null): string {
  const untouched = current === '' || (previous !== null && current === previous[field]);
  return untouched ? (next?.[field] ?? '') : current;
}

/**
 * The three price fields after the user picks another upstream model; see {@link copiedPrice}.
 *
 * @param current - What the three inputs hold now.
 * @param previous - The prices last filled in automatically, or null if none were.
 * @param next - The prices to fill in for the new pick, or null when there are none.
 * @returns The texts the three inputs should hold.
 */
export function applyCopiedPrices(current: PriceTexts, previous: PriceTexts | null, next: PriceTexts | null): PriceTexts {
  return {
    input: copiedPrice('input', current.input, previous, next),
    output: copiedPrice('output', current.output, previous, next),
    cached: copiedPrice('cached', current.cached, previous, next),
  };
}
