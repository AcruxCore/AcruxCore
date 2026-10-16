import { describe, expect, it } from 'vitest';
import type { RunCompareExample, RunReportCell } from '@/api/types';
import { ApiError } from '@/api/client';
import { compareErrorText, defaultComparePair, filterExamples, parseCompareFilter, targetRunProblem } from './compare.helpers';

const ex = (exampleId: string, change: RunCompareExample['change']): RunCompareExample => ({
  exampleId, change, input: {}, criteria: null, base: null, target: null, scoreDelta: null,
});

const cell = (cellKey: string, model: string, isProductionBaseline = false): RunReportCell =>
  ({ cellKey, model, variantLabel: cellKey.split('|')[0], isProductionBaseline }) as RunReportCell;

describe('filterExamples', () => {
  const rows = [ex('a', 'improved'), ex('b', 'regressed'), ex('c', 'unchanged'), ex('d', 'unscored')];

  it('"changed" keeps both directions and nothing else', () => {
    expect(filterExamples(rows, 'changed').map((e) => e.exampleId)).toEqual(['a', 'b']);
  });

  it('a single change kind keeps only that kind; "all" keeps everything', () => {
    expect(filterExamples(rows, 'regressed').map((e) => e.exampleId)).toEqual(['b']);
    expect(filterExamples(rows, 'all')).toHaveLength(4);
  });
});

describe('parseCompareFilter', () => {
  it('defaults to "changed" for a missing or unknown value', () => {
    expect(parseCompareFilter(null)).toBe('changed');
    expect(parseCompareFilter('banana')).toBe('changed');
    expect(parseCompareFilter('unchanged')).toBe('unchanged');
  });
});

describe('defaultComparePair', () => {
  it('opens on the baseline against the winner on the same model', () => {
    const cells = [cell('v1|m', 'm'), cell('production|m', 'm', true), cell('v3|m', 'm'), cell('v1|n', 'n')];
    expect(defaultComparePair(cells, 'v3|m')).toEqual(['production|m', 'v3|m']);
  });

  it('falls back to another same-model cell, then any other cell', () => {
    expect(defaultComparePair([cell('production|m', 'm', true), cell('v1|m', 'm')], 'v9|x')).toEqual(['production|m', 'v1|m']);
    expect(defaultComparePair([cell('v1|m', 'm'), cell('v1|n', 'n')], null)).toEqual(['v1|m', 'v1|n']);
  });

  it('has no target when the run has one cell', () => {
    expect(defaultComparePair([cell('v1|m', 'm')], null)).toEqual(['v1|m', null]);
  });
});

describe('targetRunProblem', () => {
  it('names a target run that failed to load, so the page does not spin forever', () => {
    expect(targetRunProblem({ isError: true, grid: undefined })).toBe('not-found');
  });

  it('names a target run with no cells', () => {
    expect(targetRunProblem({ isError: false, grid: [] })).toBe('no-cells');
  });

  it('is null while the run loads and once it has cells', () => {
    expect(targetRunProblem({ isError: false, grid: undefined })).toBeNull();
    expect(targetRunProblem({ isError: false, grid: [{ cellKey: 'v1|m' }] })).toBeNull();
  });
});

describe('compareErrorText', () => {
  it('blames the dataset only for a real dataset mismatch', () => {
    expect(compareErrorText(new ApiError(400, 'DATASET_MISMATCH', 'x'))).toMatch(/same dataset/);
  });

  it('says a cell in the link is unknown on a 404, not that the datasets differ', () => {
    const text = compareErrorText(new ApiError(404, 'NOT_FOUND', 'Cell "v9|gpt-4o" is not in run r'));
    expect(text).not.toMatch(/same dataset/);
    expect(text).toMatch(/not in its run/);
  });

  it("falls back to the API's own message for anything else", () => {
    expect(compareErrorText(new ApiError(500, 'INTERNAL', 'boom'))).toBe('boom');
  });
});
