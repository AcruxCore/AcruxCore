import { describe, expect, it } from 'vitest';
import { deltaToChip, scoreToGrade } from './matrix.helpers';

describe('scoreToGrade', () => {
  it('maps scores to grade buckets, null -> unscored', () => {
    expect(scoreToGrade(null)).toBe('unscored');
    expect(scoreToGrade(90)).toBe('high');
    expect(scoreToGrade(30)).toBe('low');
  });

  it('treats the mid band as inclusive-exclusive [50, 80)', () => {
    expect(scoreToGrade(50)).toBe('mid');
    expect(scoreToGrade(79)).toBe('mid');
    expect(scoreToGrade(80)).toBe('high');
    expect(scoreToGrade(49)).toBe('low');
  });
});

describe('deltaToChip', () => {
  it('maps regression delta to a chip', () => {
    expect(deltaToChip({ score: 12, passRate: null, label: 'improved' }).tone).toBe('up');
    expect(deltaToChip({ score: -12, passRate: null, label: 'regressed' }).tone).toBe('down');
    expect(deltaToChip(null).tone).toBe('flat'); // baseline itself
  });

  it('labels the baseline cell distinctly from a computed flat delta', () => {
    expect(deltaToChip(null).label).toMatch(/baseline/i);
    expect(deltaToChip({ score: 0, passRate: null, label: 'flat' }).tone).toBe('flat');
  });

  it('maps an incomputable delta to the unknown tone', () => {
    expect(deltaToChip({ score: null, passRate: null, label: 'unknown' }).tone).toBe('unknown');
  });

  it('incorporates the delta score into the label where available', () => {
    expect(deltaToChip({ score: 12, passRate: null, label: 'improved' }).label).toContain('12');
    expect(deltaToChip({ score: -12, passRate: null, label: 'regressed' }).label).toContain('12');
  });

  it('rounds the delta to one decimal place, like the score it sits under', () => {
    // avgScore is a mean, so 2-of-3 passing arrives as 66.66666666666667.
    expect(deltaToChip({ score: 66.66666666666667, passRate: null, label: 'improved' }).label).toBe(
      '+66.7 improved',
    );
    expect(deltaToChip({ score: -33.333333333333336, passRate: null, label: 'regressed' }).label).toBe(
      '-33.3 regressed',
    );
    expect(deltaToChip({ score: 0, passRate: null, label: 'flat' }).label).toBe('±0.0 flat');
  });
});
