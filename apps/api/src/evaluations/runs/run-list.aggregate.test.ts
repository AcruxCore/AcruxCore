import { deriveGridShape, deriveRunKind, foldRunScores } from './run-list.aggregate';

/** Builds one (run × variant) aggregate row, defaulting the counts a case does not care about. */
function agg(variantLabel: string, over: Partial<Parameters<typeof foldRunScores>[0][number]> = {}) {
  return {
    runId: 'r1',
    variantLabel,
    total: 0,
    errored: 0,
    scored: 0,
    scoreSum: 0,
    passed: 0,
    ...over,
  };
}

it('sums counts across variants and takes an exact example-weighted mean', () => {
  // v1: 4 examples averaging 75; v2: 1 example scoring 100. The mean must be
  // 400+100 over 5 = 80, NOT the average of the two per-variant means (87.5) —
  // that is what carrying scoreSum/scored instead of a pre-divided mean buys.
  const folded = foldRunScores([
    agg('v1', { total: 4, scored: 4, scoreSum: 300, passed: 3 }),
    agg('v2', { total: 1, scored: 1, scoreSum: 100, passed: 1 }),
  ]);

  expect(folded.results).toEqual({ total: 5, succeeded: 5, errored: 0, scored: 5 });
  expect(folded.avgScore).toBe(80);
  expect(folded.passRate).toBe(0.8);
  expect(folded.topVariantLabel).toBe('v2');
});

it('counts errored rows out of succeeded but keeps them in the total', () => {
  const folded = foldRunScores([agg('v1', { total: 6, errored: 2, scored: 4, scoreSum: 200, passed: 2 })]);

  expect(folded.results).toEqual({ total: 6, succeeded: 4, errored: 2, scored: 4 });
  expect(folded.avgScore).toBe(50);
});

it('reports null scores — never zero — for a run with results but nothing scored', () => {
  // Every example produced output but none carried a criterion, so the judge
  // never scored them. A `0` here would read as "scored badly".
  const folded = foldRunScores([agg('v1', { total: 3, scored: 0, scoreSum: 0 })]);

  expect(folded.results).toEqual({ total: 3, succeeded: 3, errored: 0, scored: 0 });
  expect(folded.avgScore).toBeNull();
  expect(folded.passRate).toBeNull();
  expect(folded.topVariantLabel).toBeNull();
});

it('reports zeroed counts and null scores for a run that produced nothing', () => {
  const folded = foldRunScores([]);

  expect(folded.results).toEqual({ total: 0, succeeded: 0, errored: 0, scored: 0 });
  expect(folded.avgScore).toBeNull();
  expect(folded.topVariantLabel).toBeNull();
});

it('ignores unscored variants when picking the top one, and breaks ties by label', () => {
  const withUnscored = foldRunScores([
    agg('candidate-B', { total: 2, scored: 0 }),
    agg('candidate-A', { total: 2, scored: 2, scoreSum: 90, passed: 1 }),
  ]);
  expect(withUnscored.topVariantLabel).toBe('candidate-A');

  const tied = foldRunScores([
    agg('production', { total: 2, scored: 2, scoreSum: 160, passed: 2 }),
    agg('candidate-A', { total: 1, scored: 1, scoreSum: 80, passed: 1 }),
  ]);
  expect(tied.topVariantLabel).toBe('candidate-A');
});

it('rounds the mean to 1dp and the pass rate to 3dp', () => {
  const folded = foldRunScores([agg('v1', { total: 3, scored: 3, scoreSum: 200, passed: 1 })]);

  expect(folded.avgScore).toBe(66.7);
  expect(folded.passRate).toBe(0.333);
});

it('derives the run kind from candidate cells in the grid', () => {
  const evaluation = [
    { variantKind: 'version', variantLabel: 'v1', model: 'gpt-4o-mini' },
    { variantKind: 'version', variantLabel: 'production', model: 'gpt-4o-mini' },
  ];
  const optimize = [
    { variantKind: 'candidate', variantLabel: 'candidate-A', model: 'gpt-4o-mini' },
    { variantKind: 'version', variantLabel: 'production', model: 'gpt-4o-mini' },
  ];

  expect(deriveRunKind(evaluation)).toBe('evaluation');
  expect(deriveRunKind(optimize)).toBe('optimize');
  // An optimize run's grid is empty until its candidates are drafted (the row
  // is created with `grid: []` at request time), so it reads as an evaluation
  // for that window rather than throwing.
  expect(deriveRunKind([])).toBe('evaluation');
});

it('counts distinct grid axes, not cells', () => {
  const grid = [
    { variantKind: 'version', variantLabel: 'v1', model: 'a' },
    { variantKind: 'version', variantLabel: 'v1', model: 'b' },
    { variantKind: 'version', variantLabel: 'production', model: 'a' },
    { variantKind: 'version', variantLabel: 'production', model: 'b' },
  ];

  expect(deriveGridShape(grid)).toEqual({ variantCount: 2, modelCount: 2 });
  expect(deriveGridShape([])).toEqual({ variantCount: 0, modelCount: 0 });
});
