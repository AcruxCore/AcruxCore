"""Measures what `hub.traces.ingest()` costs at the call site, awaited vs not.

The timed region is one `ingest()` call and nothing else — no embedding, no
retrieval, no other network work — so the number is the SDK's own call-site
cost, not a RAG step's. Both legs hit the same live API, alternating round by
round so a slow patch on the server hits both equally.

This is deliberately NOT a cross-tool comparison. Competing SDKs buffer a span
in memory and export it on a background thread, which is a different operation
from a completed, durable POST; comparing the two directly is what made the
original figure in issue #315 misleading. What is comparable is our own two
modes, which is what this measures.

Run:
  export ACRUXCORE_API_KEY=acx_sk_...
  export ACRUXCORE_BASE_URL=http://localhost:3001/api/v1
  python scripts/others/rag-agent-observability-comparison/python/ingest_wait_bench.py

Needs: pip install acruxcore
"""

import asyncio
import os
import statistics
import time
from typing import Any, Dict, List

import acruxcore as acrux

BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "https://acruxcore.com/api/v1")
ROUNDS = int(os.environ.get("ROUNDS", "100"))
WARMUPS = int(os.environ.get("WARMUPS", "10"))


def payload(i: int) -> Dict[str, Any]:
    """One trace carrying a single non-LLM span — the shape a retrieval step reports."""
    return {
        "name": f"retrieval-{i}",
        "spans": [
            {
                "spanId": "s1",
                "name": "vector-search",
                "kind": "retrieval",
                "status": "ok",
                "startTime": "2026-09-06T00:00:00.000Z",
                "endTime": "2026-09-06T00:00:00.100Z",
            }
        ],
    }


def summarize(name: str, samples: List[float]) -> None:
    ordered = sorted(samples)
    p = lambda q: ordered[min(len(ordered) - 1, int(q * len(ordered)))]  # noqa: E731
    print(
        f"{name:<24} median {statistics.median(ordered):7.3f}ms   "
        f"p95 {p(0.95):7.3f}ms   p99 {p(0.99):7.3f}ms   n={len(ordered)}"
    )


async def main() -> None:
    api_key = os.environ.get("ACRUXCORE_API_KEY")
    if not api_key:
        raise SystemExit("Set ACRUXCORE_API_KEY.")

    hub = acrux.AcruxCore(api_key=api_key, base_url=BASE_URL)

    # Warm up connection pool, DNS, TLS — otherwise the first awaited call
    # carries setup cost that has nothing to do with the mode under test.
    for i in range(WARMUPS):
        await hub.traces.ingest(payload(i), wait=True)
        await hub.traces.ingest(payload(i), wait=False)
    await hub.traces.flush()

    awaited: List[float] = []
    queued: List[float] = []

    # Interleaved, so drift in server latency lands on both legs alike.
    for i in range(ROUNDS):
        t0 = time.perf_counter()
        await hub.traces.ingest(payload(i), wait=True)
        t1 = time.perf_counter()
        await hub.traces.ingest(payload(i), wait=False)
        t2 = time.perf_counter()
        awaited.append((t1 - t0) * 1000)
        queued.append((t2 - t1) * 1000)

    # The queued leg's network cost has not vanished — it is paid here, once,
    # off the caller's path. Timed separately so the report stays honest.
    t0 = time.perf_counter()
    await hub.traces.flush()
    flush_ms = (time.perf_counter() - t0) * 1000

    print(f"\nBase URL: {BASE_URL}   rounds: {ROUNDS}   warmups: {WARMUPS}\n")
    summarize("ingest(wait=True)", awaited)
    summarize("ingest(wait=False)", queued)
    print(f"\nFinal flush of the buffered leg: {flush_ms:.1f}ms total for {ROUNDS} traces.")

    await hub.aclose()


if __name__ == "__main__":
    asyncio.run(main())
