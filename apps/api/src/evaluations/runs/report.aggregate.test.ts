import { buildRunReport } from './report.aggregate';

const grid = [
  { cellKey: 'production|m1', variantKind: 'version', promptVersionId: 'v2', variantLabel: 'production', model: 'm1', isProductionBaseline: true },
  { cellKey: 'v1|m1', variantKind: 'version', promptVersionId: 'v1', variantLabel: 'v1', model: 'm1', isProductionBaseline: false },
];

it('aggregates avgScore excluding unscored and labels regression vs baseline', () => {
  const results = [
    { datasetExampleId: 'e1', variantLabel: 'production', variantKind: 'version', model: 'm1', score: 60, passed: true },
    { datasetExampleId: 'e2', variantLabel: 'production', variantKind: 'version', model: 'm1', score: 60, passed: true },
    { datasetExampleId: 'e1', variantLabel: 'v1', variantKind: 'version', model: 'm1', score: 80, passed: true },
    { datasetExampleId: 'e2', variantLabel: 'v1', variantKind: 'version', model: 'm1', score: null, passed: null }, // unscored
  ];
  const report = buildRunReport({ run: { id: 'r1', status: 'succeeded', grid }, results });

  const v1 = report.cells.find((c) => c.cellKey === 'v1|m1')!;
  expect(v1.avgScore).toBe(80);          // unscored e2 excluded
  expect(v1.unscoredCount).toBe(1);
  expect(v1.scoredCount).toBe(1);
  expect(v1.deltaVsBaseline!.score).toBe(20);
  expect(v1.deltaVsBaseline!.label).toBe('improved');

  const base = report.cells.find((c) => c.isProductionBaseline)!;
  expect(base.deltaVsBaseline).toBeNull();

  expect(report.winner!.cellKey).toBe('v1|m1');
  expect(report.winner!.model).toBe('m1');
  expect(report.leaderboard[0]).toBe('v1|m1');
});

it('classifies a delta exactly at the epsilon boundary as improved/regressed, not flat', () => {
  // Pins the >=/<= boundary (REGRESSION_EPSILON = 2) — a prior implementation
  // used strict >/< here, which silently misclassified an exact ±2 delta as
  // 'flat'. Baseline avgScore 60; candidate 62 (+2) must be 'improved', and a
  // second candidate at 58 (-2) must be 'regressed'.
  const improvedResults = [
    { datasetExampleId: 'e1', variantLabel: 'production', variantKind: 'version', model: 'm1', score: 60, passed: true },
    { datasetExampleId: 'e1', variantLabel: 'v1', variantKind: 'version', model: 'm1', score: 62, passed: true },
  ];
  const improved = buildRunReport({ run: { id: 'r1', status: 'succeeded', grid }, results: improvedResults });
  const v1Improved = improved.cells.find((c) => c.cellKey === 'v1|m1')!;
  expect(v1Improved.deltaVsBaseline!.score).toBe(2);
  expect(v1Improved.deltaVsBaseline!.label).toBe('improved');

  const regressedResults = [
    { datasetExampleId: 'e1', variantLabel: 'production', variantKind: 'version', model: 'm1', score: 60, passed: true },
    { datasetExampleId: 'e1', variantLabel: 'v1', variantKind: 'version', model: 'm1', score: 58, passed: true },
  ];
  const regressed = buildRunReport({ run: { id: 'r1', status: 'succeeded', grid }, results: regressedResults });
  const v1Regressed = regressed.cells.find((c) => c.cellKey === 'v1|m1')!;
  expect(v1Regressed.deltaVsBaseline!.score).toBe(-2);
  expect(v1Regressed.deltaVsBaseline!.label).toBe('regressed');
});

it('a fully-unscored cell has avgScore null and sorts last with unknown label', () => {
  const results = [
    { datasetExampleId: 'e1', variantLabel: 'production', variantKind: 'version', model: 'm1', score: 50, passed: true },
    { datasetExampleId: 'e1', variantLabel: 'v1', variantKind: 'version', model: 'm1', score: null, passed: null },
  ];
  const report = buildRunReport({ run: { id: 'r1', status: 'succeeded', grid }, results });
  const v1 = report.cells.find((c) => c.cellKey === 'v1|m1')!;
  expect(v1.avgScore).toBeNull();
  expect(v1.deltaVsBaseline!.label).toBe('unknown');
  expect(report.leaderboard[report.leaderboard.length - 1]).toBe('v1|m1');
});
