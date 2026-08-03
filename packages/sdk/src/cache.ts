import { LRUCache } from 'lru-cache';
import type { RenderResult } from './types';

/** Shape of each entry stored in the LRU cache. */
export interface CacheEntry {
  /** The rendered messages + tools returned by the API. */
  value: RenderResult;
  /** Unix timestamp (ms) when this entry was fetched. Used to compute age for SWR. */
  fetchedAt: number;
}

/**
 * Module-level LRU cache singleton.
 * Initialised on the first getCache() call; subsequent calls return the same instance.
 * Using a module-level singleton (rather than lru-cache's built-in TTL) so that
 * stale entries can be served while a background refresh is in flight.
 */
let _cache: LRUCache<string, CacheEntry> | null = null;

/**
 * Returns the module-level LRU cache, creating it on the first call.
 * `maxCacheSize` is only honoured on the first call; subsequent calls return
 * the already-initialised cache regardless of the argument.
 *
 * @param maxCacheSize - Maximum number of entries. Effective only on the first call.
 * @returns The shared LRU cache instance.
 */
export function getCache(maxCacheSize: number): LRUCache<string, CacheEntry> {
  if (!_cache) {
    _cache = new LRUCache<string, CacheEntry>({ max: maxCacheSize });
  }
  return _cache;
}

/**
 * Resets the module-level cache singleton to null.
 * FOR TESTING ONLY — do not call in production code.
 * @internal
 */
export function _resetCacheForTesting(): void {
  _cache = null;
}
