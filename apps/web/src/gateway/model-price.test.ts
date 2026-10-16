import { describe, expect, it } from 'vitest';
import { PRICE_FIELD_HINT, modelPriceText } from './model-price';

describe('modelPriceText', () => {
  it('shows both prices per million tokens, with no warning', () => {
    expect(modelPriceText(0.1, 0.5)).toEqual({
      text: 'in $0.1 / out $0.5 per 1M',
      warning: null,
    });
  });

  // Issue #594: a team can enter its provider's cached rate; the line shows it when set.
  it('shows the cached input price between the two when the model has one', () => {
    expect(modelPriceText(1.4, 4.4, 0.26).text).toBe('in $1.4 / cached $0.26 / out $4.4 per 1M');
    expect(modelPriceText(1.4, 4.4, null).text).toBe('in $1.4 / out $4.4 per 1M');
  });

  it('says plainly that an unpriced model is counted as $0', () => {
    const result = modelPriceText(null, null);
    expect(result.text).toBe('no price set');
    expect(result.warning).toBe(
      'Calls through this model are counted as $0 in Usage and budgets.',
    );
  });

  // The gateway logs a null cost when either price is missing, so the whole call counts
  // as $0 — not only the missing side.
  it('warns that a model with one missing price is counted as $0 for the whole call', () => {
    expect(modelPriceText(0.1, null)).toEqual({
      text: 'in $0.1 / out — per 1M',
      warning:
        'No output price set, so calls through this model are counted as $0 in Usage and budgets — input tokens included.',
    });
    expect(modelPriceText(null, 0.5).warning).toBe(
      'No input price set, so calls through this model are counted as $0 in Usage and budgets — output tokens included.',
    );
  });
});

describe('PRICE_FIELD_HINT', () => {
  // Shown under each price field in the model dialog. One blank price zeroes the whole
  // call, so the hint must not read as if only that field's tokens are free.
  it('says one unknown price makes the whole call $0', () => {
    expect(PRICE_FIELD_HINT).toBe('Blank = auto for known models. If either price is unknown, the whole call counts as $0.');
  });
});
