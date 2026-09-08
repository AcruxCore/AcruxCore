import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { filterStateToParams, parseFilterState, type FilterState } from './chips';

/**
 * Keeps filter state in the URL query string.
 *
 * The URL, not React state, is the source of truth — so a filtered list can be
 * linked, shared and walked with back/forward, which is how the trace list has
 * always behaved. Every change also drops `page`, because staying on page 4 of a
 * result set that no longer exists shows an empty list and reads as a bug.
 *
 * A dialog should NOT use this: its filters belong to the dialog, not the
 * address bar. Wrap {@link FilterBar} in plain `useState` there.
 *
 * @returns The current filters and a setter that rewrites the URL.
 */
export function useUrlFilterState(): [FilterState, (next: FilterState) => void] {
  const [sp, setSp] = useSearchParams();
  const state = parseFilterState(sp);

  const setState = useCallback(
    (next: FilterState) => {
      const params = filterStateToParams(next, sp);
      params.delete('page');
      setSp(params);
    },
    [sp, setSp],
  );

  return [state, setState];
}
