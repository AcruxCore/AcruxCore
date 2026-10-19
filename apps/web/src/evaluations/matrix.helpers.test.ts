import { describe, expect, it } from 'vitest';
import { deltaToChip, scoreToGrade, summarizeUnscored } from './matrix.helpers';
import type { RunReportCell } from '@/api/types';

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

describe('summarizeUnscored (issues #576, #570)', () => {
  const cell = (over: Partial<RunReportCell>): RunReportCell => ({
    cellKey: 'k',
    variantLabel: 'v1',
    model: 'm',
    isProductionBaseline: false,
    avgScore: null,
    passRate: null,
    exampleCount: 50,
    scoredCount: 50,
    unscoredCount: 0,
    deltaVsBaseline: null,
    ...over,
  });

  it('sums unscored and errored results over every cell', () => {
    const summary = summarizeUnscored([
      cell({ scoredCount: 0, unscoredCount: 50, erroredCount: 50, unscoredReason: { message: 'Provider error (402)', count: 50 } }),
      cell({ scoredCount: 28, unscoredCount: 22, erroredCount: 22, unscoredReason: { message: 'Provider rate limit (429)', count: 22 } }),
      cell({}),
    ]);
    expect(summary).toEqual({ total: 150, unscored: 72, errored: 72 });
  });

  it('reports nothing unscored for a clean run, and tolerates an API without the new fields', () => {
    expect(summarizeUnscored([cell({}), cell({})])).toEqual({ total: 100, unscored: 0, errored: 0 });
  });
});
