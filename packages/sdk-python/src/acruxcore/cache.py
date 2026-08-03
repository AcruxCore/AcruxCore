"""Module-level LRU cache for rendered prompts (stale-while-revalidate).

Mirrors the TypeScript SDK's ``cache.ts``: a process-wide singleton so that a
stale entry can be served while a background refresh is in flight. ``max_size``
is honoured only on the first :func:`get_cache` call — reuse one client.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from typing import Optional

from .types import RenderResult


@dataclass
class CacheEntry:
    """One cache slot: the rendered value plus the epoch-ms it was fetched at."""

    value: RenderResult
    fetched_at: float  # epoch milliseconds


class _LRUCache:
    """A tiny LRU cache keyed by string, bounded by ``max_size`` entries."""

    def __init__(self, max_size: int) -> None:
        self._max = max_size
        self._store: "OrderedDict[str, CacheEntry]" = OrderedDict()

    def get(self, key: str) -> Optional[CacheEntry]:
        entry = self._store.get(key)
        if entry is not None:
            self._store.move_to_end(key)  # mark most-recently-used
        return entry

    def set(self, key: str, entry: CacheEntry) -> None:
        self._store[key] = entry
        self._store.move_to_end(key)
        while len(self._store) > self._max:
            self._store.popitem(last=False)  # evict least-recently-used

    def clear(self) -> None:
        self._store.clear()


_cache: Optional[_LRUCache] = None


def get_cache(max_size: int) -> _LRUCache:
    """Return the process-wide LRU cache, creating it on the first call.

    :param max_size: Maximum entries. Effective only on the first call.
    :returns: The shared cache instance.
    """
    global _cache
    if _cache is None:
        _cache = _LRUCache(max_size)
    return _cache


def _reset_cache_for_testing() -> None:
    """Reset the singleton. FOR TESTING ONLY."""
    global _cache
    _cache = None
