"""Full-cycle latency benchmark: fetch/render a stored prompt, then send the
completion — timed together as one number per platform, against a real
OpenAI baseline (not OpenRouter, unlike every earlier latency_bench.py in
this repo).

Every platform used for LLM ops is used for three things in a real request:
fetch a stored prompt, call the model, and have that call traced. Every prior
benchmark here timed only the completion call. This one times the whole
cycle a real application actually waits on: prompt fetch/render, then
completion. Tracing is never a separate blocking step for any platform in
this benchmark — it's either written server-side as a side effect of the
completion call (AcruxCore, Helicone) or batched/async client-side (Opik,
Phoenix, Langfuse), so it never adds to what the caller waits for. See
docs/superpowers/specs/cross-cutting/2026-08-08-openai-baseline-latency-benchmark-design.md
for the full design rationale.

Legs (rotating interleaved order, same as every other latency_bench.py in
this repo):

  openai_baseline   local .format() on a hardcoded string (~0ms, no stored
                    prompt) -> raw POST to api.openai.com               (baseline)
  acx_gateway       real `acruxcore` Python SDK: hub.prompts.render() ->
                    hub.gateway.chat() — the SDK, not raw HTTP, so its
                    client-side render cache applies exactly as it would
                    for a real integrator (matches how Opik/Phoenix/Langfuse
                    are exercised below)
  acx_byok          same hub.prompts.render(), then hub.gateway.chat(...,
                    provider={base_url, api_key}) — AcruxCore's "BYO
                    provider" mode (docs/tutorials/build-a-rag-agent-
                    without-the-gateway). The SDK calls OpenAI directly,
                    skipping the gateway's rate-limit check, budget-reserve
                    transaction, and synchronous request-persist/span-write.
                    Tracing isn't skipped — the span is still reported, via
                    SpanQueue.enqueue, a fire-and-forget batched call the
                    caller never awaits. Added to isolate how much of
                    acx_gateway's overhead is that server-side DB work vs.
                    just the prompt-fetch round trip every leg pays.
  opik_tracked      Opik().get_prompt() + .format() -> track_openai-wrapped
                    client.chat.completions.create()
  phoenix_otel      phoenix.client.Client().prompts.get() + .format() ->
                    openinference-instrumented client.chat.completions.create()
  helicone_gateway  local .format() (see note below) -> POST to Helicone's
                    self-hosted AI Gateway
  langfuse_otel     langfuse.get_prompt() + .compile() ->
                    langfuse.openai-wrapped client.chat.completions.create()
  mlflow_gateway    mlflow.genai.load_prompt() + .format() -> POST to
                    MLflow's AI Gateway endpoint (OpenAI-backed)

NOTE on helicone_gateway: Helicone's own prompt-compile endpoint
(POST /v1/prompt/{id}/compile) needs a genuine Helicone-issued API key, and
this session couldn't mint one — the web UI generates the key client-side
and posts its hash to a session-authenticated jawn endpoint whose auth header
format didn't validate against a plain sign-in token. So this leg times only
the completion call (same local .format() as the baseline), not a real
prompt fetch. Its number is directly comparable to openai_baseline's
structure, not to the other platforms' two-real-round-trip cycles. Generate
a real Helicone API key via the Settings > API Keys page and wire up
HELICONE_API_KEY + the compile call to close this gap.

NOTE on MLflow: the `mlflow-server` container serves the plain tracking
server's Flask app by default unless the AI Gateway feature is actually
configured — it isn't a separate process, but no endpoint existed on this
instance so `/gateway/mlflow/v1/chat/completions` 404s (a raw Flask "not
found") until one is created. Created one for this benchmark directly via
`mlflow.store.tracking.rest_store.RestStore` (create_gateway_secret ->
create_gateway_model_definition -> create_gateway_endpoint, endpoint name
`latency-bench`, provider `openai`, model `gpt-4o-mini`) since neither the
CLI nor a documented one-liner exposes this — see the design spec for the
exact calls if this needs recreating elsewhere.

NOTE on run-to-run stability (found via 4 independent 100-round runs, three
of them back-to-back on 2026-08-09, results in `reruns_2026-08-09/`):
acx_gateway's median gap vs. openai_baseline was **not** a stable number —
194ms, then 53ms, 0ms, 63ms across the four runs, only two of which even
cleared the 95% bootstrap CI's zero line. Don't cite a single run's gap as
"the" AcruxCore overhead; if a number is needed, run it several times and
report the range, not one run's point estimate. acx_byok, by contrast, was
statistically indistinguishable from openai_baseline in all three reruns
(gap -8ms, -38ms, +39ms, every CI crossing zero) — that result held up.

Uses one simple flat-variable prompt (`latency-bench-prompt`, two variables:
company, customer_message) created fresh on every platform for this specific
benchmark, deliberately simpler than the `vip-support-triage` fixture used in
the feature-comparison posts — template complexity isn't what a latency test
measures, and a uniform simple template removes any confound between
platforms with different templating engines (Opik's "mustache" prompts, for
one, turned out to only support flat `.format(**kwargs)` substitution, not
real Mustache sections/loops).

Model: gpt-4o-mini via real OpenAI on every single leg, MLflow included —
the earlier gpt-4o-mini gap was specific to MLflow's *OpenRouter* model
picker; a native OpenAI provider config on MLflow's gateway reaches
gpt-4o-mini fine (verified with a real curl before this leg was added).

Env vars required: OPENAI_API_KEY, ACX_GATEWAY_KEY, LANGFUSE_PUBLIC_KEY,
LANGFUSE_SECRET_KEY. Optional (defaults shown): ACX_BASE_URL
(http://localhost:3001/api/v1), LANGFUSE_HOST (http://localhost:3050),
OPIK_URL_OVERRIDE (http://localhost:5273/api), OPIK_WORKSPACE (default),
PHOENIX_BASE_URL (http://localhost:6006), HELICONE_BASE_URL
(http://localhost:8585), MLFLOW_TRACKING_URI (http://localhost:5000),
MLFLOW_ENDPOINT_NAME (latency-bench).

Usage: python full-cycle-latency-bench.py [rounds] [warmup]
Needs: pip install opik openai langfuse arize-phoenix-otel
       arize-phoenix-client openinference-instrumentation-openai requests
       mlflow==3.15.1
"""

import asyncio
import json
import math
import os
import random
import sys
import time

import requests

ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 100
WARMUP = int(sys.argv[2]) if len(sys.argv) > 2 else 3

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
ACX_GATEWAY_KEY = os.environ.get("ACX_GATEWAY_KEY")
LANGFUSE_PUBLIC_KEY = os.environ.get("LANGFUSE_PUBLIC_KEY")
LANGFUSE_SECRET_KEY = os.environ.get("LANGFUSE_SECRET_KEY")

for name, val in [
    ("OPENAI_API_KEY", OPENAI_API_KEY),
    ("ACX_GATEWAY_KEY", ACX_GATEWAY_KEY),
    ("LANGFUSE_PUBLIC_KEY", LANGFUSE_PUBLIC_KEY),
    ("LANGFUSE_SECRET_KEY", LANGFUSE_SECRET_KEY),
]:
    if not val:
        sys.exit(f"{name} is not set")

ACX_BASE_URL = os.environ.get("ACX_BASE_URL", "http://localhost:3001/api/v1")
LANGFUSE_HOST = os.environ.get("LANGFUSE_HOST", "http://localhost:3050")
OPIK_URL_OVERRIDE = os.environ.get("OPIK_URL_OVERRIDE", "http://localhost:5273/api")
PHOENIX_BASE_URL = os.environ.get("PHOENIX_BASE_URL", "http://localhost:6006")
HELICONE_BASE_URL = os.environ.get("HELICONE_BASE_URL", "http://localhost:8585")
MLFLOW_TRACKING_URI = os.environ.get("MLFLOW_TRACKING_URI", "http://localhost:5000")
MLFLOW_ENDPOINT_NAME = os.environ.get("MLFLOW_ENDPOINT_NAME", "latency-bench")

os.environ.setdefault("OPIK_URL_OVERRIDE", OPIK_URL_OVERRIDE)
os.environ.setdefault("OPIK_WORKSPACE", "default")
os.environ["LANGFUSE_PUBLIC_KEY"] = LANGFUSE_PUBLIC_KEY
os.environ["LANGFUSE_SECRET_KEY"] = LANGFUSE_SECRET_KEY
os.environ["LANGFUSE_HOST"] = LANGFUSE_HOST

VARIABLES = {
    "company": "Acme Corp",
    "customer_message": (
        "My export button is greyed out, can someone look at this today?"
    ),
}
MODEL = "gpt-4o-mini"
PROMPT_NAME = "latency-bench-prompt"

session = requests.Session()

# ── lazy platform clients (only imported/constructed once) ─────────────────
from opik import Opik
from opik.integrations.openai import track_openai as opik_track_openai
from openai import OpenAI
from openinference.instrumentation.openai import OpenAIInstrumentor
from phoenix.otel import register as phoenix_register
from phoenix.client import Client as PhoenixClient
from langfuse import get_client as get_langfuse_client
from langfuse.openai import openai as langfuse_openai
from acruxcore import AcruxCore
import mlflow
import mlflow.genai as mlflow_genai

acx_loop = asyncio.new_event_loop()
asyncio.set_event_loop(acx_loop)
acx_hub = AcruxCore(api_key=ACX_GATEWAY_KEY, base_url=ACX_BASE_URL)
acx_loop.run_until_complete(acx_hub.__aenter__())

opik_client = Opik(project_name="full-cycle-latency-bench")
opik_openai_client = opik_track_openai(
    OpenAI(api_key=OPENAI_API_KEY), project_name="full-cycle-latency-bench"
)

phoenix_tracer_provider = phoenix_register(
    endpoint=f"{PHOENIX_BASE_URL}/v1/traces",
    project_name="full-cycle-latency-bench",
    auto_instrument=False,
)
OpenAIInstrumentor().instrument(tracer_provider=phoenix_tracer_provider)
phoenix_openai_client = OpenAI(api_key=OPENAI_API_KEY)
phoenix_prompt_client = PhoenixClient(base_url=PHOENIX_BASE_URL)

langfuse_client = get_langfuse_client()
langfuse_openai_client = langfuse_openai.OpenAI(api_key=OPENAI_API_KEY)

plain_openai_client = OpenAI(api_key=OPENAI_API_KEY)

mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
mlflow_session = requests.Session()


# ── legs: each returns (total_ms, fetch_ms, complete_ms) ────────────────────


def openai_baseline():
    t0 = time.perf_counter()
    system = f"You are a support triage agent for {VARIABLES['company']}. Reply concisely, under 3 sentences."
    user = VARIABLES["customer_message"]
    t1 = time.perf_counter()
    plain_openai_client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        max_tokens=5,
        temperature=0,
    )
    t2 = time.perf_counter()
    return (t2 - t0) * 1000, (t1 - t0) * 1000, (t2 - t1) * 1000


async def _acx_gateway_async():
    t0 = time.perf_counter()
    rendered = await acx_hub.prompts.render(PROMPT_NAME, "production", VARIABLES)
    t1 = time.perf_counter()
    await acx_hub.gateway.chat(
        rendered.model, rendered.messages, temperature=0, max_tokens=5
    )
    t2 = time.perf_counter()
    return (t2 - t0) * 1000, (t1 - t0) * 1000, (t2 - t1) * 1000


def acx_gateway():
    # Uses the real `acruxcore` SDK (not raw HTTP) so its default client-side
    # render cache (see PR178) applies exactly as it would for a real
    # integrator — matching how Opik/Phoenix/Langfuse's own SDKs are used
    # below, rather than unfairly forcing AcruxCore's fetch phase cold every
    # round while the others benefit from their SDKs' caching.
    return acx_loop.run_until_complete(_acx_gateway_async())


ACX_BYOK_PROVIDER = {"base_url": "https://api.openai.com/v1", "api_key": OPENAI_API_KEY}


async def _acx_byok_async():
    # NOTE: rendered.model is AcruxCore's public alias (e.g. "gpt-4o-mini-openai"),
    # resolved to the real upstream model server-side by the gateway. BYO mode
    # skips that resolution and posts straight to the provider, so it needs the
    # real provider model id (MODEL) instead — same one every other leg uses.
    t0 = time.perf_counter()
    rendered = await acx_hub.prompts.render(PROMPT_NAME, "production", VARIABLES)
    t1 = time.perf_counter()
    await acx_hub.gateway.chat(
        MODEL,
        rendered.messages,
        temperature=0,
        max_tokens=5,
        provider=ACX_BYOK_PROVIDER,
        prompt_version_id=rendered.version_id,
    )
    t2 = time.perf_counter()
    return (t2 - t0) * 1000, (t1 - t0) * 1000, (t2 - t1) * 1000


def acx_byok():
    # BYO-provider mode (docs/tutorials/build-a-rag-agent-without-the-gateway):
    # the SDK calls OpenAI directly from the client, skipping the gateway's
    # request-path work entirely (no rate-limit check, no budget-reserve
    # transaction, no synchronous request-persist/span-write before this call
    # returns). The trace still gets reported — via `SpanQueue.enqueue`, a
    # fire-and-forget batched call the caller never waits on — so tracing
    # isn't traded away, only the gateway's synchronous DB work is. This leg
    # isolates how much of acx_gateway's overhead is that DB work vs. just
    # the prompt-fetch round trip every leg pays.
    return acx_loop.run_until_complete(_acx_byok_async())


def opik_tracked():
    t0 = time.perf_counter()
    prompt = opik_client.get_prompt(name="latency-bench-prompt-v2")
    rendered = prompt.format(**VARIABLES)
    t1 = time.perf_counter()
    opik_openai_client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": rendered}],
        max_tokens=5,
        temperature=0,
    )
    t2 = time.perf_counter()
    return (t2 - t0) * 1000, (t1 - t0) * 1000, (t2 - t1) * 1000


def phoenix_otel():
    t0 = time.perf_counter()
    prompt = phoenix_prompt_client.prompts.get(prompt_identifier=PROMPT_NAME)
    formatted = prompt.format(variables=VARIABLES)
    t1 = time.perf_counter()
    phoenix_openai_client.chat.completions.create(
        messages=formatted.messages,
        max_tokens=5,
        temperature=0,
        **formatted.kwargs,
    )
    t2 = time.perf_counter()
    return (t2 - t0) * 1000, (t1 - t0) * 1000, (t2 - t1) * 1000


def helicone_gateway():
    # See module docstring: prompt-fetch leg blocked this session, times
    # only the completion call, same local-format cost as openai_baseline.
    t0 = time.perf_counter()
    system = f"You are a support triage agent for {VARIABLES['company']}. Reply concisely, under 3 sentences."
    user = VARIABLES["customer_message"]
    t1 = time.perf_counter()
    res = session.post(
        f"{HELICONE_BASE_URL}/v1/gateway/oai/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
        json={
            "model": MODEL,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "max_tokens": 5,
            "temperature": 0,
        },
        timeout=30,
    )
    res.raise_for_status()
    res.json()
    t2 = time.perf_counter()
    return (t2 - t0) * 1000, (t1 - t0) * 1000, (t2 - t1) * 1000


def langfuse_otel():
    t0 = time.perf_counter()
    prompt = langfuse_client.get_prompt(PROMPT_NAME, label="production")
    compiled = prompt.compile(**VARIABLES)
    t1 = time.perf_counter()
    langfuse_openai_client.chat.completions.create(
        model=MODEL,
        messages=compiled,
        max_tokens=5,
        temperature=0,
    )
    t2 = time.perf_counter()
    return (t2 - t0) * 1000, (t1 - t0) * 1000, (t2 - t1) * 1000


def mlflow_gateway():
    t0 = time.perf_counter()
    prompt = mlflow_genai.load_prompt(f"prompts:/{PROMPT_NAME}@production")
    rendered = prompt.format(**VARIABLES)
    t1 = time.perf_counter()
    res = mlflow_session.post(
        f"{MLFLOW_TRACKING_URI}/gateway/mlflow/v1/chat/completions",
        json={
            "model": MLFLOW_ENDPOINT_NAME,
            "messages": [{"role": "user", "content": rendered}],
            "max_tokens": 5,
            "temperature": 0,
        },
        timeout=30,
    )
    res.raise_for_status()
    res.json()
    t2 = time.perf_counter()
    return (t2 - t0) * 1000, (t1 - t0) * 1000, (t2 - t1) * 1000


PATHS = [
    {"key": "openai_baseline", "label": "OpenAI direct (baseline)", "run": openai_baseline},
    {"key": "acx_gateway", "label": "AcruxCore gateway", "run": acx_gateway},
    {"key": "acx_byok", "label": "AcruxCore BYOK (gateway-free)", "run": acx_byok},
    {"key": "opik_tracked", "label": "Opik tracked SDK", "run": opik_tracked},
    {"key": "phoenix_otel", "label": "Phoenix OTel SDK", "run": phoenix_otel},
    {"key": "helicone_gateway", "label": "Helicone AI Gateway*", "run": helicone_gateway},
    {"key": "langfuse_otel", "label": "Langfuse OTel SDK", "run": langfuse_otel},
    {"key": "mlflow_gateway", "label": "MLflow AI Gateway", "run": mlflow_gateway},
]

samples = {p["key"]: [] for p in PATHS}
fetch_samples = {p["key"]: [] for p in PATHS}
complete_samples = {p["key"]: [] for p in PATHS}
failures = {p["key"]: 0 for p in PATHS}


def pct(sorted_vals, p):
    if not sorted_vals:
        return float("nan")
    i = min(len(sorted_vals) - 1, math.ceil((p / 100) * len(sorted_vals)) - 1)
    return sorted_vals[max(0, i)]


def spearman_rho(xs, ys):
    """Rank correlation between round index and latency — the test for 'is this
    actually climbing' that a bucketed-median printout can't answer on its own."""

    def rank(vals):
        order = sorted(range(len(vals)), key=lambda i: vals[i])
        ranks = [0] * len(vals)
        for r, i in enumerate(order):
            ranks[i] = r + 1
        return ranks

    n = len(xs)
    rx, ry = rank(xs), rank(ys)
    d2 = sum((a - b) ** 2 for a, b in zip(rx, ry))
    return 1 - (6 * d2) / (n * (n**2 - 1))


def permutation_p_value(xs, ys, observed_rho, trials=2000):
    """Two-sided permutation p-value for `observed_rho`: how often a random
    shuffle of the same latencies produces a correlation at least as extreme."""
    ys_shuffled = list(ys)
    count = 0
    for _ in range(trials):
        random.shuffle(ys_shuffled)
        if abs(spearman_rho(xs, ys_shuffled)) >= abs(observed_rho):
            count += 1
    return count / trials


def main():
    print(f"rounds={ROUNDS} warmup={WARMUP} paths={len(PATHS)}\n")

    for round_num in range(WARMUP + ROUNDS):
        measured = round_num >= WARMUP
        order = [PATHS[(i + round_num) % len(PATHS)] for i in range(len(PATHS))]

        for path in order:
            try:
                total_ms, fetch_ms, complete_ms = path["run"]()
                if measured:
                    samples[path["key"]].append(total_ms)
                    fetch_samples[path["key"]].append(fetch_ms)
                    complete_samples[path["key"]].append(complete_ms)
            except Exception as err:  # noqa: BLE001
                if measured:
                    failures[path["key"]] += 1
                print(f"  ! {path['key']}: {err}")

        if measured and (round_num - WARMUP + 1) % 10 == 0:
            done = round_num - WARMUP + 1
            line = "  ".join(
                f"{p['key']}={round(sorted(samples[p['key']])[len(samples[p['key']]) // 2])}"
                for p in PATHS
                if samples[p["key"]]
            )
            print(f"round {done}/{ROUNDS}  median  {line}")

    print("\n=== simple summary: platform -> median full-cycle latency ===")
    for p in PATHS:
        s = sorted(samples[p["key"]])
        median = round(pct(s, 50)) if s else float("nan")
        print(f"{p['label']:<28} {median} ms")

    print("\n=== full results ===")
    table = []
    for p in PATHS:
        s = sorted(samples[p["key"]])
        fs = sorted(fetch_samples[p["key"]])
        cs = sorted(complete_samples[p["key"]])
        row = {
            "key": p["key"],
            "label": p["label"],
            "n": len(s),
            "failures": failures[p["key"]],
            "median": round(pct(s, 50)) if s else None,
            "p95": round(pct(s, 95)) if s else None,
            "p99": round(pct(s, 99)) if s else None,
            "min": round(s[0]) if s else None,
            "max": round(s[-1]) if s else None,
            "mean": round(sum(s) / len(s)) if s else None,
            "fetch_median": round(pct(fs, 50)) if fs else None,
            "complete_median": round(pct(cs, 50)) if cs else None,
        }
        table.append(row)
        print(
            f"{p['label']:<28} n={row['n']} fail={row['failures']}  "
            f"median={row['median']}  p95={row['p95']}  p99={row['p99']}  "
            f"min={row['min']}  max={row['max']}  "
            f"(fetch={row['fetch_median']}  complete={row['complete_median']})"
        )

    with open("results.json", "w") as f:
        json.dump(
            {
                "rounds": ROUNDS,
                "warmup": WARMUP,
                "model": MODEL,
                "table": table,
                "samples": samples,
                "fetch_samples": fetch_samples,
                "complete_samples": complete_samples,
            },
            f,
            indent=2,
        )
    print("\nwrote results.json")

    print("\n=== median gap vs openai_baseline (95% CI, 5000-resample bootstrap) ===")
    baseline = samples["openai_baseline"]
    for p in PATHS:
        if p["key"] == "openai_baseline":
            continue
        other = samples[p["key"]]
        if not other or not baseline:
            print(f"{p['label']:<28} no data (all rounds failed)")
            continue
        baseline_sorted = sorted(baseline)
        other_sorted = sorted(other)
        point_gap = other_sorted[len(other_sorted) // 2] - baseline_sorted[len(baseline_sorted) // 2]
        diffs = []
        for _ in range(5000):
            ra = sorted(random.choice(baseline) for _ in baseline)
            rb = sorted(random.choice(other) for _ in other)
            diffs.append(rb[len(rb) // 2] - ra[len(ra) // 2])
        diffs.sort()
        lo = diffs[int(0.025 * len(diffs))]
        hi = diffs[int(0.975 * len(diffs))]
        crosses_zero = lo <= 0 <= hi
        print(
            f"{p['label']:<28} gap={round(point_gap)}ms  "
            f"95% CI=[{round(lo)}, {round(hi)}]ms"
            f"{'  <-- CROSSES ZERO: not statistically distinguishable' if crosses_zero else ''}"
        )

    print(
        "\n* helicone_gateway times completion only, not a real prompt fetch "
        "(see module docstring) — not directly comparable to the other "
        "platforms' two-round-trip cycles."
    )

    print("\n=== within-run trend check (Spearman rho vs round index, 2000-shuffle permutation p) ===")
    print(
        "A real network benchmark is noisy (500-1800ms swings are normal for a live\n"
        "OpenAI call) — eyeballing a printed per-10-round median table for a 'climb'\n"
        "WILL find one by chance. This checks whether any leg's round-over-round order\n"
        "actually correlates with latency, instead of trusting the eyeball read."
    )
    for p in PATHS:
        vals = samples[p["key"]]
        if len(vals) < 10:
            continue
        rho = spearman_rho(list(range(len(vals))), vals)
        p_value = permutation_p_value(list(range(len(vals))), vals, rho)
        flag = "  <-- LIKELY REAL TREND (p<0.05, verify before reporting)" if p_value < 0.05 else ""
        print(f"{p['label']:<28} rho={rho:+.3f}  p={p_value:.3f}{flag}")
    print(
        f"\nNote: with {len(PATHS)} legs tested independently, ~1 in 3 runs will show a lone"
        " p<0.05 by chance alone (no multiple-comparison correction here) — a"
        " single flagged leg is not enough to call it a real trend on its own;"
        " re-run and see if the same leg flags again before reporting one."
    )


if __name__ == "__main__":
    try:
        main()
    finally:
        acx_loop.run_until_complete(acx_hub.__aexit__(None, None, None))
        acx_loop.close()
