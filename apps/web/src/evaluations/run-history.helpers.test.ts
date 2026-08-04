import { expect, it } from 'vitest';
import type { RunListItem } from '@/api/types';
import {
  formatDuration,
  formatPassRate,
  formatScore,
  runResultsLine,
  runShapeLine,
  runStatusChip,
  runSubtitle,
  runTitle,
} from './run-history.helpers';

/** A finished, scored run; each test overrides only the fields it is about. */
function run(over: Partial<RunListItem> = {}): RunListItem {
  return {
    id: 'r1',
    status: 'succeeded',
    kind: 'evaluation',
    experimentId: 'x1',
    experimentName: 'greeting sweep',
    datasetId: 'd1',
    datasetName: 'greetings',
    promptId: 'p1',
    promptName: 'greeting',
    variantCount: 2,
    modelCount: 1,
    exampleCount: 12,
    results: { total: 24, succeeded: 24, errored: 0, scored: 24 },
    avgScore: 66.7,
    passRate: 0.5,
    topVariantLabel: 'v3',
    startedBy: { id: 'u1', name: 'Al', email: 'al@example.com' },
    createdAt: '2026-08-04T10:00:00.000Z',
    startedAt: '2026-08-04T10:00:01.000Z',
    endedAt: '2026-08-04T10:00:09.400Z',
    durationMs: 8400,
    ...over,
  };
}

it('titles a row by its experiment name, then the prompt, then the dataset', () => {
  expect(runTitle(run())).toBe('greeting sweep');
  expect(runTitle(run({ experimentName: null }))).toBe('greeting');
  // A whitespace-only name is not a name.
  expect(runTitle(run({ experimentName: '   ' }))).toBe('greeting');
  expect(runTitle(run({ experimentName: null, promptName: null }))).toBe('greetings');
});

it('does not title an optimize run “optimize” — the optimizer’s placeholder is not a name', () => {
  const optimizeRun = run({ kind: 'optimize', experimentName: 'optimize' });
  expect(runTitle(optimizeRun)).toBe('greeting');
  // A user-chosen name that merely contains the word is still a name.
  expect(runTitle(run({ experimentName: 'optimize the tone' }))).toBe('optimize the tone');
});

it('names the dataset in the subtitle, unless it is already the title', () => {
  expect(runSubtitle(run())).toBe('greetings · 2 variants × 1 model · 12 examples');
  expect(runSubtitle(run({ experimentName: null, promptName: null }))).toBe(
    '2 variants × 1 model · 12 examples',
  );
});

it('describes the grid shape, singularising each unit', () => {
  expect(runShapeLine(run())).toBe('2 variants × 1 model · 12 examples');
  expect(runShapeLine(run({ variantCount: 1, modelCount: 2, exampleCount: 1 }))).toBe(
    '1 variant × 2 models · 1 example',
  );
});

it('says the grid is still resolving instead of “0 variants × 0 models”', () => {
  // An optimize run's grid is empty until its candidates are drafted.
  expect(runShapeLine(run({ variantCount: 0, modelCount: 0, exampleCount: 3 }))).toBe('Resolving grid…');
});

it('shows an em dash — never a zero — for an unscored run', () => {
  expect(formatScore(run().avgScore)).toBe('66.7');
  expect(formatScore(null)).toBe('—');
  expect(formatScore(0)).toBe('0.0');
  expect(formatPassRate(null)).toBeNull();
  expect(formatPassRate(0.5)).toBe('50% passed');
  expect(formatPassRate(0.333)).toBe('33% passed');
});

it('formats durations in the largest useful unit', () => {
  expect(formatDuration(null)).toBe('—');
  expect(formatDuration(820)).toBe('820ms');
  expect(formatDuration(7400)).toBe('7.4s');
  expect(formatDuration(125_000)).toBe('2m 05s');
  expect(formatDuration(120_000)).toBe('2m 00s');
});

it('marks queued and running as in flight, and colours each status distinctly', () => {
  expect(runStatusChip('queued').inFlight).toBe(true);
  expect(runStatusChip('running').inFlight).toBe(true);
  expect(runStatusChip('succeeded').inFlight).toBe(false);
  expect(runStatusChip('failed')).toMatchObject({ label: 'Failed', inFlight: false });

  const labels = (['queued', 'running', 'succeeded', 'failed'] as const).map((s) => runStatusChip(s).label);
  expect(new Set(labels).size).toBe(4);
});

it('mentions errors in the results line only when there are some', () => {
  expect(runResultsLine(run())).toBe('24 results · 24 scored');
  expect(runResultsLine(run({ results: { total: 6, succeeded: 4, errored: 2, scored: 4 } }))).toBe(
    '6 results · 2 errored · 4 scored',
  );
  expect(runResultsLine(run({ results: { total: 1, succeeded: 1, errored: 0, scored: 0 } }))).toBe(
    '1 result · 0 scored',
  );
});
