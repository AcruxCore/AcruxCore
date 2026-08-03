import { describe, expect, it } from 'vitest';
import { formatSkipped } from './format-skipped';

describe('formatSkipped', () => {
  it('reports only the added count when nothing was skipped', () => {
    expect(formatSkipped(5, [])).toBe('5 added.');
  });

  it('reports both counts when some rows were skipped', () => {
    expect(
      formatSkipped(3, [
        { feedbackId: 'a', reason: 'no captured variables' },
        { feedbackId: 'b', reason: 'no captured variables' },
      ]),
    ).toBe('3 added, 2 skipped.');
  });

  it('handles zero added with all skipped', () => {
    expect(formatSkipped(0, [{ feedbackId: 'a', reason: 'no captured variables' }])).toBe('0 added, 1 skipped.');
  });
});
