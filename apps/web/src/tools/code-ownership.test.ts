import { describe, expect, it } from 'vitest';
import { codeOwnedBanner } from './code-ownership';

describe('codeOwnedBanner', () => {
  it('shows nothing when no production alias is set', () => {
    expect(codeOwnedBanner(null, null)).toBe('none');
    expect(codeOwnedBanner(undefined, 'anything')).toBe('none');
  });

  it('shows nothing for a dashboard- or api-authored live version', () => {
    expect(codeOwnedBanner('dashboard', 'Check whether a column may be shown.')).toBe('none');
    expect(codeOwnedBanner('api', null)).toBe('none');
  });

  it('warns that a deploy supersedes the edit when the code owns the description', () => {
    expect(codeOwnedBanner('code', 'Run a read-only SQL SELECT against the store database.')).toBe(
      'deploy-supersedes',
    );
  });

  it('tells the editor the wording is theirs when the code sends no description', () => {
    // A decorated function with no docstring: sync carries the live description
    // forward, so it can never supersede what is written in the dashboard.
    expect(codeOwnedBanner('code', null)).toBe('description-is-yours');
    expect(codeOwnedBanner('code', undefined)).toBe('description-is-yours');
    expect(codeOwnedBanner('code', '   ')).toBe('description-is-yours');
  });
});
