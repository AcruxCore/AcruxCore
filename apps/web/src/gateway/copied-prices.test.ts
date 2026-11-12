import { describe, expect, it } from 'vitest';
import { applyCopiedPrices, pricesFromListing } from './copied-prices';

const EMPTY = { input: '', output: '', cached: '' };
const M3 = { input: '0.3', output: '1.2', cached: '0.06' };
const FLASH = { input: '0.08', output: '0.15', cached: '' };

describe('pricesFromListing', () => {
  it('turns listed prices into form text, leaving cached blank when the list has none', () => {
    expect(pricesFromListing({ inputPricePerM: 0.3, outputPricePerM: 1.2, cachedInputPricePerM: 0.06 })).toEqual(M3);
    expect(pricesFromListing({ inputPricePerM: 0.08, outputPricePerM: 0.15 })).toEqual(FLASH);
    expect(pricesFromListing(undefined)).toBeNull();
  });
});

describe('applyCopiedPrices', () => {
  it('fills blank fields from the picked model', () => {
    expect(applyCopiedPrices(EMPTY, null, M3)).toEqual(M3);
  });

  it('replaces copied prices when another model is picked', () => {
    expect(applyCopiedPrices(M3, M3, FLASH)).toEqual(FLASH);
  });

  it('keeps a price the user typed', () => {
    expect(applyCopiedPrices({ ...M3, output: '2' }, M3, FLASH)).toEqual({ input: '0.08', output: '2', cached: '' });
  });

  it('clears copied prices when the new pick has none listed', () => {
    expect(applyCopiedPrices(M3, M3, null)).toEqual(EMPTY);
    expect(applyCopiedPrices({ ...M3, input: '5' }, M3, null)).toEqual({ input: '5', output: '', cached: '' });
  });
});
