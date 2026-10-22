import { describe, expect, it } from 'vitest';
import {
  bestCandidate,
  summarizeCandidates,
  type OptimizeGridCell,
  type OptimizeReportCell,
} from '../../src/optimize-report';

/** A grid cell: baseline when no candidate id is given. */
function gridCell(key: string, model: string, label: string, candidateId?: string): OptimizeGridCell {
  return candidateId
    ? { cellKey: key, variantKind: 'candidate', variantLabel: label, model, promptCandidateId: candidateId }
    : { cellKey: key, variantKind: 'version', variantLabel: label, model, isProductionBaseline: true };
}

/** A report cell with the delta label the server computed. */
function reportCell(
  key: string,
  model: string,
  avgScore: number,
  label: 'improved' | 'regressed' | 'flat' | 'unknown' | null,
  delta: number | null = null,
): OptimizeReportCell {
  return {
    cellKey: key,
    variantLabel: key,
    model,
    isProductionBaseline: label === null,
    avgScore,
    passRate: null,
    scoredCount: 2,
    exampleCount: 2,
    deltaVsBaseline: label === null ? null : { score: delta, passRate: null, label },
  };
}

const GRID = [
  gridCell('base-m1', 'm1', 'production'),
  gridCell('base-m2', 'm2', 'production'),
  gridCell('a-m1', 'm1', 'candidate-A', 'cand-a'),
  gridCell('a-m2', 'm2', 'candidate-A', 'cand-a'),
  gridCell('b-m1', 'm1', 'candidate-B', 'cand-b'),
  gridCell('b-m2', 'm2', 'candidate-B', 'cand-b'),
];

describe('summarizeCandidates', () => {
  it('joins the candidate id from the grid onto the report scores, one row per candidate', () => {
    const cells = [
      reportCell('base-m1', 'm1', 40, null),
      reportCell('base-m2', 'm2', 50, null),
      reportCell('a-m1', 'm1', 90, 'improved', 50),
      reportCell('a-m2', 'm2', 50, 'flat', 0),
      reportCell('b-m1', 'm1', 40, 'flat', 0),
      reportCell('b-m2', 'm2', 50, 'flat', 0),
    ];

    const summaries = summarizeCandidates(GRID, cells);

    expect(summaries.map((s) => [s.label, s.candidateId, s.beatsBaseline])).toEqual([
      ['candidate-A', 'cand-a', true],
      ['candidate-B', 'cand-b', false],
    ]);
    expect(summaries[0].scores[0]).toEqual({
      model: 'm1',
      avgScore: 90,
      passRate: null,
      baselineAvgScore: 40,
      scoreDelta: 50,
      verdict: 'improved',
    });
  });

  // The prompt is shared by every model that runs it, so a win on one model that costs a
  // regression on another is not a safe thing to ship.
  it('does not call a rewrite a win when it regressed on any model', () => {
    const cells = [
      reportCell('base-m1', 'm1', 40, null),
      reportCell('base-m2', 'm2', 50, null),
      reportCell('a-m1', 'm1', 90, 'improved', 50),
      reportCell('a-m2', 'm2', 10, 'regressed', -40),
      reportCell('b-m1', 'm1', 40, 'flat', 0),
      reportCell('b-m2', 'm2', 50, 'flat', 0),
    ];

    const summaries = summarizeCandidates(GRID, cells);

    expect(summaries.every((s) => !s.beatsBaseline)).toBe(true);
    expect(bestCandidate(summaries)).toBeNull();
  });

  it('treats an unscored cell as no evidence, not as a win', () => {
    const cells = [
      reportCell('base-m1', 'm1', 40, null),
      reportCell('a-m1', 'm1', 0, 'unknown'),
    ];

    const summaries = summarizeCandidates(GRID.filter((c) => c.model === 'm1' && c.cellKey !== 'b-m1'), cells);

    expect(summaries[0].beatsBaseline).toBe(false);
  });

  // The rewrite would serve m2 traffic too, where it never produced a scored answer.
  it('does not call a rewrite a win when one of its models has no scores', () => {
    const cells = [
      reportCell('base-m1', 'm1', 40, null),
      reportCell('base-m2', 'm2', 50, null),
      reportCell('a-m1', 'm1', 90, 'improved', 50),
      reportCell('a-m2', 'm2', 0, 'unknown'),
      reportCell('b-m1', 'm1', 40, 'flat', 0),
      reportCell('b-m2', 'm2', 50, 'flat', 0),
    ];

    const summaries = summarizeCandidates(GRID, cells);

    expect(summaries[0].beatsBaseline).toBe(false);
    expect(bestCandidate(summaries)).toBeNull();
  });
});

describe('bestCandidate', () => {
  it('recommends the winning rewrite with the largest mean gain', () => {
    const cells = [
      reportCell('base-m1', 'm1', 40, null),
      reportCell('base-m2', 'm2', 50, null),
      reportCell('a-m1', 'm1', 50, 'improved', 10),
      reportCell('a-m2', 'm2', 50, 'flat', 0),
      reportCell('b-m1', 'm1', 70, 'improved', 30),
      reportCell('b-m2', 'm2', 55, 'improved', 5),
    ];

    expect(bestCandidate(summarizeCandidates(GRID, cells))?.candidateId).toBe('cand-b');
  });
});
