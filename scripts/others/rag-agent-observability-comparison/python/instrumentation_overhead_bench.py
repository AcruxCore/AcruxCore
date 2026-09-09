"""Measures what each instrumentation style costs at the call site.

The question this answers: if you wrap one already-working function in a
tracing layer, how much wall-clock does the wrapper add *synchronously*, before
your next line of code runs?

Method
------
The timed unit is one Chroma similarity query against a pre-built collection —
the retrieval half of the RAG agent, with the embedding call hoisted out so no
network request happens inside the timed region. Every leg runs the identical
query; only the instrumentation around it changes.

- `baseline`  — no tracing at all.
- `langfuse`  — Langfuse's `@observe` decorator.
- `mlflow`    — MLflow's `@mlflow.trace` decorator.
- `phoenix`   — a raw OpenTelemetry span from the Phoenix-registered tracer.
- `acruxcore` — `traces.ingest()`, which is an HTTP POST rather than an
                in-process span, and is therefore reported separately below.

Legs are interleaved in a rotating order each round so a slow moment on the
machine lands on all of them equally rather than on whichever ran last.
Warm-up rounds are discarded. Results report median, p95 and p99, plus the gap
against baseline with a 95% bootstrap confidence interval — a CI that crosses
zero means the difference is indistinguishable from zero, not a win.

What this does NOT measure: the background export. Every decorator here buffers
spans and ships them on another thread, so its real network cost is off the
critical path and invisible to this benchmark. That is the point of the
comparison — `acruxcore`'s ingest is on the critical path, and the numbers show
what that costs.

Run:
  export OPENROUTER_KEY=sk-or-v1-...
  export LANGFUSE_SECRET_KEY=sk-lf-...  LANGFUSE_PUBLIC_KEY=pk-lf-...
  export LANGFUSE_HOST=http://localhost:3050
  export MLFLOW_TRACKING_URI=http://localhost:5000
  export PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006
  export ACRUXCORE_API_KEY=acx_sk_...  ACRUXCORE_BASE_URL=http://localhost:3001/api/v1
  python scripts/others/rag-agent-observability-comparison/python/instrumentation_overhead_bench.py

Needs: pip install langfuse mlflow arize-phoenix-otel opentelemetry-sdk acruxcore \
                   chromadb requests beautifulsoup4
"""

from __future__ import annotations

import asyncio
import os
import random
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import rag_core

ROUNDS = int(os.environ.get("BENCH_ROUNDS", "100"))
WARMUP = int(os.environ.get("BENCH_WARMUP", "10"))
TOP_K = 4

if not os.environ.get("OPENROUTER_KEY"):
    sys.exit("OPENROUTER_KEY is not set (needed once, to build the index)")


def percentile(values: list[float], pct: float) -> float:
    """Nearest-rank percentile, so a 100-sample run needs no interpolation."""
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(round(pct / 100 * len(ordered) + 0.5)) - 1)
    return ordered[idx]


def bootstrap_ci(
    treatment: list[float], baseline: list[float], iterations: int = 5000
) -> tuple[float, float]:
    """95% CI for the median gap (treatment - baseline), resampling both legs."""
    rng = random.Random(20260817)
    gaps: list[float] = []
    for _ in range(iterations):
        t = [rng.choice(treatment) for _ in treatment]
        b = [rng.choice(baseline) for _ in baseline]
        gaps.append(statistics.median(t) - statistics.median(b))
    gaps.sort()
    lo = gaps[int(0.025 * len(gaps))]
    hi = gaps[int(0.975 * len(gaps))]
    return lo, hi


print(f"Building the index once (shared by every leg)...")
collection = rag_core.build_index()

# Hoist the embedding out of the timed region: one network call here, none later.
[query_embedding] = rag_core.embed_texts([rag_core.QUESTION])


def do_query() -> int:
    """The timed unit — one local similarity search, no network."""
    results = collection.query(query_embeddings=[query_embedding], n_results=TOP_K)
    return len(results["documents"][0])


# --- leg setup -------------------------------------------------------------

MODE = os.environ.get("BENCH_MODE", "critical-path")
if MODE not in {"critical-path", "durable"}:
    sys.exit("BENCH_MODE must be 'critical-path' or 'durable'")

legs: dict[str, callable] = {"baseline": do_query}
# In `durable` mode the leg's flush runs inside the timed region, so every
# platform pays the cost of getting the span to its backend rather than only
# the cost of buffering it in memory.
flushers: dict[str, callable] = {}
skipped: dict[str, str] = {}

# Langfuse @observe
try:
    from langfuse import get_client, observe

    if not os.environ.get("LANGFUSE_SECRET_KEY"):
        raise RuntimeError("LANGFUSE_SECRET_KEY is not set")
    _lf = get_client()

    @observe(name="search_docs", as_type="retriever")
    def _langfuse_leg() -> int:
        return do_query()

    legs["langfuse"] = _langfuse_leg
    flushers["langfuse"] = _lf.flush
except Exception as exc:  # noqa: BLE001 - a missing leg is reported, never faked
    skipped["langfuse"] = str(exc)

# MLflow @mlflow.trace
try:
    import mlflow
    from mlflow.entities import SpanType

    mlflow.set_tracking_uri(os.environ.get("MLFLOW_TRACKING_URI", "http://localhost:5000"))
    mlflow.set_experiment("rag-agent-observability-bench")

    @mlflow.trace(name="search_docs", span_type=SpanType.RETRIEVER)
    def _mlflow_leg() -> int:
        return do_query()

    legs["mlflow"] = _mlflow_leg
    flushers["mlflow"] = mlflow.flush_trace_async_logging
except Exception as exc:  # noqa: BLE001
    skipped["mlflow"] = str(exc)

# Phoenix / raw OpenTelemetry
try:
    from phoenix.otel import register

    _tp = register(
        project_name="rag-agent-observability-bench",
        endpoint=os.environ.get("PHOENIX_COLLECTOR_ENDPOINT", "http://localhost:6006")
        + "/v1/traces",
        auto_instrument=False,
        batch=True,
    )
    _tracer = _tp.get_tracer(__name__)

    def _phoenix_leg() -> int:
        with _tracer.start_as_current_span("search_docs") as span:
            n = do_query()
            span.set_attribute("openinference.span.kind", "RETRIEVER")
            return n

    legs["phoenix"] = _phoenix_leg
    flushers["phoenix"] = _tp.force_flush
except Exception as exc:  # noqa: BLE001
    skipped["phoenix"] = str(exc)

# AcruxCore traces.ingest() — an HTTP POST, not an in-process span.
_acx_leg = None
try:
    import acruxcore as acrux
    from datetime import datetime, timezone

    if not os.environ.get("ACRUXCORE_API_KEY"):
        raise RuntimeError("ACRUXCORE_API_KEY is not set")

    _hub = acrux.AcruxCore(
        api_key=os.environ["ACRUXCORE_API_KEY"],
        base_url=os.environ.get("ACRUXCORE_BASE_URL", "http://localhost:3001/api/v1"),
    )

    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    async def _acx_once() -> int:
        started = _now()
        n = do_query()
        await _hub.traces.ingest(
            {
                "name": "rag-agent-bench",
                "spans": [
                    {
                        "spanId": "search_docs",
                        "name": "search_docs",
                        "kind": "retrieval",
                        "startTime": started,
                        "endTime": _now(),
                    }
                ],
            }
        )
        return n

    _acx_leg = _acx_once
except Exception as exc:  # noqa: BLE001
    skipped["acruxcore"] = str(exc)


# --- run -------------------------------------------------------------------

names = list(legs)
samples: dict[str, list[float]] = {n: [] for n in names}
acx_samples: list[float] = []

print(f"Legs: {', '.join(names)}" + (f" (+acruxcore)" if _acx_leg else ""))
for name, why in skipped.items():
    print(f"  SKIPPED {name}: {why}")
print(f"Mode: {MODE} | Rounds: {ROUNDS} (discarding {WARMUP} warm-up)\n")

loop = asyncio.new_event_loop() if _acx_leg else None

for round_no in range(ROUNDS + WARMUP):
    # Rotate the order every round so no leg always runs first.
    order = names[round_no % len(names) :] + names[: round_no % len(names)]
    for name in order:
        flush = flushers.get(name) if MODE == "durable" else None
        start = time.perf_counter()
        legs[name]()
        if flush:
            flush()
        elapsed_ms = (time.perf_counter() - start) * 1000
        if round_no >= WARMUP:
            samples[name].append(elapsed_ms)

    if _acx_leg:
        start = time.perf_counter()
        loop.run_until_complete(_acx_leg())
        elapsed_ms = (time.perf_counter() - start) * 1000
        if round_no >= WARMUP:
            acx_samples.append(elapsed_ms)

    if (round_no + 1) % 25 == 0:
        print(f"  {round_no + 1}/{ROUNDS + WARMUP} rounds")

if loop:
    loop.close()

# --- report ----------------------------------------------------------------

base = samples["baseline"]

heading = ("In-process span creation (no network on the critical path)"
           if MODE == "critical-path"
           else "Span durably recorded (flush inside the timed region)")
print(f"\n## {heading}\n")
print(f"{'leg':<12} {'median':>9} {'p95':>9} {'p99':>9} {'gap vs baseline':>32}")
for name in names:
    vals = samples[name]
    med, p95, p99 = statistics.median(vals), percentile(vals, 95), percentile(vals, 99)
    if name == "baseline":
        gap = "—"
    else:
        lo, hi = bootstrap_ci(vals, base)
        crosses = " (crosses zero)" if lo <= 0 <= hi else ""
        gap = f"{med - statistics.median(base):+.3f}ms [{lo:+.3f}, {hi:+.3f}]{crosses}"
    print(f"{name:<12} {med:>8.3f}ms {p95:>8.3f}ms {p99:>8.3f}ms {gap:>32}")

if acx_samples:
    med = statistics.median(acx_samples)
    lo, hi = bootstrap_ci(acx_samples, base)
    print("\n## AcruxCore traces.ingest() — an awaited POST, durable either way\n")
    print(f"{'leg':<12} {'median':>9} {'p95':>9} {'p99':>9} {'gap vs baseline':>32}")
    crosses = " (crosses zero)" if lo <= 0 <= hi else ""
    print(
        f"{'acruxcore':<12} {med:>8.3f}ms {percentile(acx_samples, 95):>8.3f}ms "
        f"{percentile(acx_samples, 99):>8.3f}ms "
        f"{f'{med - statistics.median(base):+.3f}ms [{lo:+.3f}, {hi:+.3f}]{crosses}':>32}"
    )

print(f"\nSamples per leg: {len(base)}")
