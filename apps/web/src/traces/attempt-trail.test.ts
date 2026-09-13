import { describe, expect, it } from 'vitest';
import { summarizeAttempts } from './attempt-trail';

/** One model called four times: the gateway retried the same deployment and it answered. */
const retried = [
  { modelId: 'a1', model: 'free-tier-model', upstreamModel: 'liquid/lfm-2.5-2.6b:free', attempts: 4 },
];

/** Two models, one call each: a 401 is never retried, so the chain moved on immediately. */
const felloverClean = [
  { modelId: 'a1', model: 'unstable-4o-mini', upstreamModel: 'gpt-4o-mini', attempts: 1, error: '401' },
  {
    modelId: 'b2',
    model: 'mistral-small',
    upstreamModel: 'mistralai/mistral-small-3.2-24b-instruct',
    attempts: 1,
  },
];

describe('summarizeAttempts', () => {
  it('calls repeated calls to a single model a retry, and counts them', () => {
    expect(summarizeAttempts(4, retried)?.verdict).toBe('retried 3 times');
  });

  it('counts a single retry as "once" rather than "1 times"', () => {
    expect(summarizeAttempts(2, [{ model: 'free-tier-model', attempts: 2 }])?.verdict).toBe('retried once');
  });

  it('says which model answered after a fallback, and that nothing was retried first', () => {
    expect(summarizeAttempts(2, felloverClean)?.verdict).toBe(
      'fell back to mistral-small, no retry first',
    );
  });

  it('reports the retry and the fallback when both happened', () => {
    const both = [{ ...felloverClean[0], attempts: 2 }, felloverClean[1]];
    expect(summarizeAttempts(3, both)?.verdict).toBe('retried once, then fell back to mistral-small');
  });

  it('says so when the model it fell back to failed as well', () => {
    const allFailed = [felloverClean[0], { ...felloverClean[1], error: '500' }];
    expect(summarizeAttempts(2, allFailed)?.verdict).toBe(
      'fell back to mistral-small, which failed too',
    );
  });

  it('carries the provider own message so a reader sees what went wrong', () => {
    const withMessage = [
      { ...felloverClean[0], errorMessage: 'Incorrect API key provided: sk-revok****demo.' },
      felloverClean[1],
    ];
    const rows = summarizeAttempts(2, withMessage)!.rows;
    expect(rows[0].errorMessage).toBe('Incorrect API key provided: sk-revok****demo.');
    expect(rows[1].errorMessage).toBeUndefined();
  });

  it('shows what a retried model was failing on, even though it answered in the end', () => {
    const retriedThenAnswered = [
      {
        model: 'free-tier-model',
        upstreamModel: 'liquid/lfm-2.5-2.6b:free',
        attempts: 3,
        retriedAfter: { error: '429', errorMessage: 'Rate limit exceeded.' },
      },
    ];
    const row = summarizeAttempts(3, retriedThenAnswered)!.rows[0];
    expect(row.outcome).toBe('answered');
    expect(row.errorMessage).toBe('Rate limit exceeded.');
    expect(row.retriedAfterStatus).toBe('429');
  });

  it('names every model tried, its upstream name, and how its turn ended', () => {
    expect(summarizeAttempts(2, felloverClean)?.rows).toEqual([
      {
        model: 'unstable-4o-mini',
        upstreamModel: 'gpt-4o-mini',
        attempts: 1,
        outcome: 'failed 401',
        errorMessage: undefined,
        retriedAfterStatus: undefined,
      },
      {
        model: 'mistral-small',
        upstreamModel: 'mistralai/mistral-small-3.2-24b-instruct',
        attempts: 1,
        outcome: 'answered',
        errorMessage: undefined,
        retriedAfterStatus: undefined,
      },
    ]);
  });

  it('reads a trail written before models were named, without crashing', () => {
    const legacy = [{ modelId: '4eeda09c-0bf6-409d-b19e-9f8b728d4013' }];
    const summary = summarizeAttempts(3, legacy);
    // One entry and no per-entry count: the chain total is that entry's own count.
    expect(summary?.rows[0]).toEqual({
      model: '4eeda09c',
      upstreamModel: undefined,
      attempts: 3,
      outcome: 'answered',
      errorMessage: undefined,
      retriedAfterStatus: undefined,
    });
    expect(summary?.verdict).toBe('retried twice');
  });

  it('returns null when a single attempt succeeded, so the panel shows no row', () => {
    expect(summarizeAttempts(1, [{ model: 'fast', attempts: 1 }])).toBeNull();
  });

  it('returns null when there is no trail to read', () => {
    expect(summarizeAttempts(4, [])).toBeNull();
    expect(summarizeAttempts(undefined, undefined)).toBeNull();
  });
});
