import { describe, expect, it } from 'vitest';
import type { RunReport, RunReportVariant } from '@/api/types';
import { optimizerRejectionsNote } from './optimizer-rejections';

const baseline: RunReportVariant = { variantKind: 'version', variantLabel: 'production', isProductionBaseline: true };
const candidate = (n: number): RunReportVariant => ({
  variantKind: 'candidate',
  variantLabel: `candidate-${n}`,
  isProductionBaseline: false,
});
const reason = 'candidate 3: dropped {{ message }} (a rewrite must keep exactly the original variables)';

function report(over: Partial<RunReport>): Pick<RunReport, 'status' | 'variants' | 'optimizerRejections'> {
  return { status: 'succeeded', variants: [baseline, candidate(1), candidate(2)], optimizerRejections: [reason], ...over };
}

describe('optimizerRejectionsNote', () => {
  it('counts the kept rewrites from the report itself', () => {
    expect(optimizerRejectionsNote(report({}))).toEqual({ rejections: [reason], kept: 2 });
  });

  it('still explains the dropped rewrites when every kept rewrite errored and the run failed', () => {
    expect(optimizerRejectionsNote(report({ status: 'failed' }))).toEqual({ rejections: [reason], kept: 2 });
  });

  it('shows nothing when no rewrite was kept, since the run error already names the reasons', () => {
    expect(optimizerRejectionsNote(report({ status: 'failed', variants: [baseline] }))).toBeNull();
  });

  it('shows nothing when no rewrite was dropped, or the server predates the field', () => {
    expect(optimizerRejectionsNote(report({ optimizerRejections: [] }))).toBeNull();
    expect(optimizerRejectionsNote(report({ optimizerRejections: undefined }))).toBeNull();
  });
});
