import { describe, expect, it } from 'vitest';
import { pollWhileInFlight } from './evaluations';
import { keys } from './queryClient';

describe('evaluations query keys', () => {
  it('datasets is a stable, deep-equal singleton key', () => {
    expect(keys.datasets).toEqual(['datasets']);
    expect(keys.datasets).toBe(keys.datasets);
  });

  it('dataset(id) is unique per id and stable across calls with the same id', () => {
    expect(keys.dataset('a')).toEqual(['dataset', 'a']);
    expect(keys.dataset('a')).toEqual(keys.dataset('a'));
    expect(keys.dataset('a')).not.toEqual(keys.dataset('b'));
  });

  it('experiments is a stable singleton key', () => {
    expect(keys.experiments).toEqual(['experiments']);
  });

  it('experiment(id) is unique per id', () => {
    expect(keys.experiment('exp-1')).toEqual(['experiment', 'exp-1']);
    expect(keys.experiment('exp-1')).not.toEqual(keys.experiment('exp-2'));
  });

  it('runs(filters) varies with the filters and never collides with run(id)', () => {
    expect(keys.runs({ page: 1, limit: 20 })).toEqual(['runs', { page: 1, limit: 20 }]);
    expect(keys.runs({ page: 1 })).not.toEqual(keys.runs({ page: 2 }));
    expect(keys.runs({ status: 'failed' })).not.toEqual(keys.runs({ status: 'succeeded' }));
    // A filtered list and a single run must not share a cache entry.
    expect(keys.runs({ page: 1 })).not.toEqual(keys.run('1'));
  });

  it('run(id) is unique per id and deep-equal across calls', () => {
    expect(keys.run('a')).toEqual(['run', 'a']);
    expect(keys.run('a')).toEqual(keys.run('a'));
    expect(keys.run('a')).not.toEqual(keys.run('b'));
  });

  it('runReport(id) is unique per id and distinct from run(id)', () => {
    expect(keys.runReport('a')).toEqual(['runReport', 'a']);
    expect(keys.runReport('a')).not.toEqual(keys.run('a'));
    expect(keys.runReport('a')).not.toEqual(keys.runReport('b'));
  });

  it('runCell(id, cellKey) is unique per (id, cellKey) pair', () => {
    expect(keys.runCell('run-1', 'v2|gpt-4o-mini')).toEqual(['runCell', 'run-1', 'v2|gpt-4o-mini']);
    expect(keys.runCell('run-1', 'v2|gpt-4o-mini')).not.toEqual(keys.runCell('run-1', 'production|gpt-4o-mini'));
    expect(keys.runCell('run-1', 'v2|gpt-4o-mini')).not.toEqual(keys.runCell('run-2', 'v2|gpt-4o-mini'));
  });

  it('all evaluation key namespaces are pairwise distinct at the root', () => {
    const roots = [
      keys.datasets[0],
      keys.dataset('x')[0],
      keys.experiments[0],
      keys.experiment('x')[0],
      keys.run('x')[0],
      keys.runReport('x')[0],
      keys.runCell('x', 'y')[0],
    ];
    expect(new Set(roots).size).toBe(roots.length);
  });
});

describe('pollWhileInFlight', () => {
  it('polls at the fixed interval while queued or running', () => {
    expect(pollWhileInFlight('queued')).toBe(1500);
    expect(pollWhileInFlight('running')).toBe(1500);
  });

  it('stops polling once the run has settled', () => {
    expect(pollWhileInFlight('succeeded')).toBe(false);
    expect(pollWhileInFlight('failed')).toBe(false);
  });

  it('stops polling before the first fetch resolves (status undefined)', () => {
    expect(pollWhileInFlight(undefined)).toBe(false);
  });
});
