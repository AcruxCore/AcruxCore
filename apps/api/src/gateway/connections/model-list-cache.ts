import type { ListedModel } from '../providers/list-models';

/** How long a provider's model list is reused before it is read again. */
export const MODEL_LIST_TTL_MS = 60 * 60 * 1000;

/** Most lists kept at once; the oldest entry is dropped past this, so memory stays bounded. */
const MAX_ENTRIES = 500;

interface Entry {
  models: ListedModel[];
  expiresAt: number;
}

/**
 * An in-process cache of provider model lists, keyed by connection.
 *
 * The key includes the connection's `updatedAt`, so rotating its key or changing its
 * base URL misses the cache without any explicit invalidation. Memory rather than
 * Redis: the list only feeds a dropdown, so a separate copy per API process costs at
 * most one extra provider call per process per hour, and it keeps the gateway from
 * depending on the evaluation queue's Redis connection.
 */
export class ModelListCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly ttlMs: number = MODEL_LIST_TTL_MS) {}

  /** Builds the key for one version of a connection. */
  static key(connectionId: string, updatedAt: Date): string {
    return `${connectionId}:${updatedAt.getTime()}`;
  }

  /**
   * Returns the cached list, or `undefined` when there is none or it has expired.
   *
   * @param key - From {@link ModelListCache.key}.
   * @param now - Current time in ms; a parameter so expiry can be tested without waiting.
   */
  get(key: string, now: number = Date.now()): ListedModel[] | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.models;
  }

  /**
   * Stores a list. Only successful reads are stored, so a failure is retried next time.
   *
   * @param key - From {@link ModelListCache.key}.
   * @param models - The list to keep.
   * @param now - Current time in ms.
   */
  set(key: string, models: ListedModel[], now: number = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { models, expiresAt: now + this.ttlMs });
    // A Map iterates in insertion order, so the first key is the oldest write.
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/** The one cache the connections service uses. */
export const modelListCache = new ModelListCache();
