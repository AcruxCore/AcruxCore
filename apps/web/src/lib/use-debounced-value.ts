import { useEffect, useState } from 'react';

/**
 * Returns `value` once it has stopped changing for `delayMs`.
 *
 * For an input that drives a request per change: a burst of keystrokes becomes one
 * request for the final text. The first render returns `value` straight away, so a
 * component that mounts with content does not wait out the delay before its first
 * request.
 *
 * @param value - The live value. Compared by reference, so pass a stable object (state,
 *   or a `useMemo` result) rather than a fresh literal each render.
 * @param delayMs - Quiet period in milliseconds before the new value is returned.
 * @returns The latest value that has been stable for `delayMs`.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
