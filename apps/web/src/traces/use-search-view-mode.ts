import { useCallback, useState } from 'react';

/** How a search step is drawn: document rows, or the stored input and output as JSON. */
export type SearchViewMode = 'documents' | 'json';

const STORAGE_KEY = 'acx.traces.searchView';

/** Reads the saved mode; storage can be blocked (private window), so failure means the default. */
function readMode(): SearchViewMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'json' ? 'json' : 'documents';
  } catch {
    return 'documents';
  }
}

/**
 * The viewer's choice between document rows and JSON for search steps, remembered in
 * this browser so the next search step opens the same way. A per-viewer convenience: if
 * storage is unavailable the choice simply lasts until the step is closed.
 *
 * @returns The current mode and a setter that also saves it.
 */
export function useSearchViewMode(): [SearchViewMode, (mode: SearchViewMode) => void] {
  const [mode, setModeState] = useState<SearchViewMode>(readMode);
  const setMode = useCallback((next: SearchViewMode) => {
    setModeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage blocked: keep the in-memory choice only.
    }
  }, []);
  return [mode, setMode];
}
