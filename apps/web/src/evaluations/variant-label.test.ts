import { describe, expect, it } from 'vitest';
import { variantDisplayLabel } from './variant-label';

describe('variantDisplayLabel', () => {
  it('names the version behind an alias', () => {
    expect(variantDisplayLabel('production', 1)).toBe('v1 (production)');
  });

  it('leaves a plain version label alone', () => {
    expect(variantDisplayLabel('v2', 2)).toBe('v2');
  });

  it('keeps the label when the version is unknown (old runs, optimizer candidates)', () => {
    expect(variantDisplayLabel('production', null)).toBe('production');
    expect(variantDisplayLabel('candidate-1', undefined)).toBe('candidate-1');
  });
});
