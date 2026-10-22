import { describe, expect, it, vi } from 'vitest';
import { datasetForAttempt } from './improve-from-feedback';

const body = { name: 'refunds', overall_feedback: 'Be brief.', feedback_ids: ['f1', 'f2'] };

describe('datasetForAttempt', () => {
  it('reuses the dataset a refused attempt created when the retry asks for the same one', async () => {
    let n = 0;
    const create = vi.fn(async () => ({ id: `ds-${++n}` }));

    const first = await datasetForAttempt(null, body, create);
    // The optimize call was refused here; the user fixes the judge prompt and clicks again.
    const second = await datasetForAttempt(first, { ...body, feedback_ids: ['f1', 'f2'] }, create);

    expect(create).toHaveBeenCalledTimes(1);
    expect(second.id).toBe('ds-1');
  });

  it('creates a new dataset when the retry changed what the dataset holds', async () => {
    let n = 0;
    const create = vi.fn(async () => ({ id: `ds-${++n}` }));

    const first = await datasetForAttempt(null, body, create);
    const renamed = await datasetForAttempt(first, { ...body, name: 'refunds v2' }, create);
    const fewerRows = await datasetForAttempt(renamed, { ...body, name: 'refunds v2', feedback_ids: ['f1'] }, create);

    expect(create).toHaveBeenCalledTimes(3);
    expect([first.id, renamed.id, fewerRows.id]).toEqual(['ds-1', 'ds-2', 'ds-3']);
  });
});
