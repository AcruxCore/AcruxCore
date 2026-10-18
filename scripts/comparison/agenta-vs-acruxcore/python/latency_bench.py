"""Interleaved latency benchmark backing "AcruxCore vs Agenta".

One fixed call ("Reply with the single word: pong.", openai/gpt-4o-mini,
max_tokens 5, temperature 0) measured five ways. Every leg ends at
**openrouter.ai** with the same model, so the model's own time is shared and
what is left over is the path:

  provider_direct    raw HTTPS POST to openrouter.ai/api/v1             (baseline)
  agenta_traced      OpenAI client -> openrouter.ai, traced by the Agenta SDK
                     (ag.init + OpenAIInstrumentor; spans exported in batches)
  agenta_invoke      POST {AGENTA_HOST}/services/chat/v0/invoke for the app
                     deployed to production: Agenta fetches the prompt, renders
                     it and calls the model in its services container
  acx_gateway        raw POST to the AcruxCore gateway                   (one hop)
  acx_render_gateway POST /prompts/pong-bench/production/render, then the
                     gateway call: the stored-prompt path, two HTTP calls

agenta_invoke and acx_render_gateway are the like-for-like pair: both look up a
stored prompt, render it, and send it to the model through the platform.

Preflight: the gateway model must be bound to an OpenRouter credential, or the
AcruxCore legs would end at a different host from the baseline and the gap
would measure two providers instead of the gateway.

Rounds rotate the leg order so a network blip hits every leg equally; warm-up
rounds are discarded.

Setup (once):
  Agenta  - an app with slug AGENTA_APP_SLUG (default pong-bench) whose prompt
            is the pong message on openrouter/openai/gpt-4o-mini, deployed to
            production.
  AcruxCore - a prompt named pong-bench with the same message, production alias.

Env vars: OPENROUTER_API_KEY, AGENTA_API_KEY, AGENTA_HOST, ACX_GATEWAY_KEY, and
optionally ACX_BASE_URL (default http://localhost:3001/api/v1), ACX_MODEL
(default gpt-4o-mini-or) and AGENTA_APP_SLUG (default pong-bench).

Usage: python latency_bench.py [rounds] [warmup] [results-file]
Needs: pip install agenta openai opentelemetry-instrumentation-openai requests
"""

import json
import math
import os
import random
import sys
import time

import requests

ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 100
WARMUP = int(sys.argv[2]) if len(sys.argv) > 2 else 3
RESULTS_FILE = sys.argv[3] if len(sys.argv) > 3 else "results.json"

for name in ("OPENROUTER_API_KEY", "AGENTA_API_KEY", "AGENTA_HOST", "ACX_GATEWAY_KEY"):
    if not os.environ.get(name):
        sys.exit(f"{name} is not set")

OPENROUTER_API_KEY = os.environ["OPENROUTER_API_KEY"]
AGENTA_API_KEY = os.environ["AGENTA_API_KEY"]
AGENTA_HOST = os.environ["AGENTA_HOST"].rstrip("/")
AGENTA_APP_SLUG = os.environ.get("AGENTA_APP_SLUG", "pong-bench")
GATEWAY_KEY = os.environ["ACX_GATEWAY_KEY"]
ACX_BASE_URL = os.environ.get("ACX_BASE_URL", "http://localhost:3001/api/v1")
ACX_MODEL = os.environ.get("ACX_MODEL", "gpt-4o-mini-or")

OPENROUTER_MODEL = "openai/gpt-4o-mini"
MESSAGES = [{"role": "user", "content": "Reply with the single word: pong."}]
BODY = {"messages": MESSAGES, "max_tokens": 5, "temperature": 0}


def assert_gateway_upstream_is_openrouter() -> None:
    """Exits unless ACX_MODEL resolves to openai/gpt-4o-mini on an OpenRouter credential."""
    res = requests.get(
        f"{ACX_BASE_URL}/gateway/models",
        headers={"Authorization": f"Bearer {GATEWAY_KEY}"},
        timeout=15,
    )
    res.raise_for_status()
    match = next((m for m in res.json() if m.get("publicName") == ACX_MODEL), None)
    if match is None:
        sys.exit(f"preflight failed: no gateway model named {ACX_MODEL!r}")
    # The model row names its connection; the connection holds the upstream host.
    conns = requests.get(
        f"{ACX_BASE_URL}/gateway/connections",
        headers={"Authorization": f"Bearer {GATEWAY_KEY}"},
        timeout=15,
    )
    conns.raise_for_status()
    conn = next((c for c in conns.json() if c.get("id") == match.get("credentialId")), {})
    base_url = (conn.get("config") or {}).get("base_url", "")
    if match.get("upstreamModel") != OPENROUTER_MODEL or "openrouter.ai" not in base_url:
        sys.exit(
            f"preflight failed: {ACX_MODEL!r} -> {match.get('upstreamModel')!r} at "
            f"{base_url or 'the provider default'}; expected {OPENROUTER_MODEL!r} on openrouter.ai"
        )
    print(
        f"preflight ok: {ACX_MODEL!r} -> {match.get('upstreamModel')!r} at {base_url}; "
        f"baseline -> openrouter.ai/{OPENROUTER_MODEL}\n"
    )


assert_gateway_upstream_is_openrouter()

import agenta as ag
from openai import OpenAI
from opentelemetry.instrumentation.openai import OpenAIInstrumentor

ag.init(host=AGENTA_HOST, api_key=AGENTA_API_KEY)
OpenAIInstrumentor().instrument()

session = requests.Session()
traced_client = OpenAI(api_key=OPENROUTER_API_KEY, base_url="https://openrouter.ai/api/v1")


def provider_direct():
    res = session.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}"},
        json={"model": OPENROUTER_MODEL, **BODY},
        timeout=30,
    )
    res.raise_for_status()
    res.json()


@ag.instrument()
def agenta_traced():
    traced_client.chat.completions.create(model=OPENROUTER_MODEL, **BODY)


def agenta_invoke():
    res = session.post(
        f"{AGENTA_HOST}/services/chat/v0/invoke",
        headers={"Authorization": f"ApiKey {AGENTA_API_KEY}"},
        json={
            "data": {"inputs": {"messages": []}},
            "references": {
                "application": {"slug": AGENTA_APP_SLUG},
                "environment": {"slug": "production"},
            },
        },
        timeout=30,
    )
    res.raise_for_status()
    body = res.json()
    # The service answers HTTP 200 with the real outcome in status.code.
    if body.get("status", {}).get("code") != 200:
        raise RuntimeError(body.get("status"))


def acx_gateway():
    res = session.post(
        f"{ACX_BASE_URL}/gateway/chat/completions",
        headers={"Authorization": f"Bearer {GATEWAY_KEY}"},
        json={"model": ACX_MODEL, **BODY},
        timeout=30,
    )
    res.raise_for_status()
    res.json()


def acx_render_gateway():
    rendered = session.post(
        f"{ACX_BASE_URL}/prompts/pong-bench/production/render",
        headers={"Authorization": f"Bearer {GATEWAY_KEY}"},
        json={"variables": {}},
        timeout=30,
    )
    rendered.raise_for_status()
    r = rendered.json()
    res = session.post(
        f"{ACX_BASE_URL}/gateway/chat/completions",
        headers={"Authorization": f"Bearer {GATEWAY_KEY}"},
        json={
            "model": r["model"],
            "messages": r["messages"],
            "max_tokens": 5,
            "temperature": 0,
            "prompt_version_id": r["versionId"],
        },
        timeout=30,
    )
    res.raise_for_status()
    res.json()


PATHS = [
    {"key": "provider_direct", "label": "OpenRouter direct", "run": provider_direct},
    {"key": "agenta_traced", "label": "Agenta traced SDK", "run": agenta_traced},
    {"key": "agenta_invoke", "label": "Agenta invoke", "run": agenta_invoke},
    {"key": "acx_gateway", "label": "AcruxCore gateway", "run": acx_gateway},
    {"key": "acx_render_gateway", "label": "AcruxCore render+gateway", "run": acx_render_gateway},
]

samples = {p["key"]: [] for p in PATHS}
failures = {p["key"]: 0 for p in PATHS}


def pct(sorted_vals, p):
    if not sorted_vals:
        return float("nan")
    i = min(len(sorted_vals) - 1, math.ceil((p / 100) * len(sorted_vals)) - 1)
    return sorted_vals[max(0, i)]


def median(vals):
    # The mean of the two middle values for an even count, so the table and the
    # gap below always use the same definition.
    s = sorted(vals)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def main():
    print(f"rounds={ROUNDS} warmup={WARMUP} paths={len(PATHS)}\n")

    for round_num in range(WARMUP + ROUNDS):
        measured = round_num >= WARMUP
        order = [PATHS[(i + round_num) % len(PATHS)] for i in range(len(PATHS))]

        for path in order:
            t0 = time.perf_counter()
            try:
                path["run"]()
                ms = (time.perf_counter() - t0) * 1000
                if measured:
                    samples[path["key"]].append(ms)
            except Exception as err:  # noqa: BLE001
                if measured:
                    failures[path["key"]] += 1
                print(f"  ! {path['key']}: {err}")

        if measured and (round_num - WARMUP + 1) % 10 == 0:
            done = round_num - WARMUP + 1
            line = "  ".join(
                f"{p['key']}={round(median(samples[p['key']]))}" for p in PATHS if samples[p["key"]]
            )
            print(f"round {done}/{ROUNDS}  median  {line}", flush=True)

    print("\n=== results ===")
    table = []
    for p in PATHS:
        s = sorted(samples[p["key"]])
        row = {
            "key": p["key"],
            "label": p["label"],
            "n": len(s),
            "failures": failures[p["key"]],
            "median": round(median(s)),
            "p95": round(pct(s, 95)),
            "p99": round(pct(s, 99)),
            "min": round(s[0]),
            "max": round(s[-1]),
            "mean": round(sum(s) / len(s)),
        }
        table.append(row)
        print(
            f"{p['label']:<26} n={row['n']} fail={row['failures']}  "
            f"median={row['median']}  p95={row['p95']}  p99={row['p99']}  "
            f"min={row['min']}  max={row['max']}"
        )

    print("\n=== median gap vs provider_direct (95% CI, 5000-resample bootstrap) ===")
    baseline = samples["provider_direct"]
    gaps = {}
    for p in PATHS:
        if p["key"] == "provider_direct":
            continue
        other = samples[p["key"]]
        point_gap = median(other) - median(baseline)
        diffs = sorted(
            median([random.choice(other) for _ in other]) - median([random.choice(baseline) for _ in baseline])
            for _ in range(5000)
        )
        lo, hi = diffs[int(0.025 * len(diffs))], diffs[int(0.975 * len(diffs))]
        gaps[p["key"]] = {"gap": round(point_gap), "ci_low": round(lo), "ci_high": round(hi)}
        print(
            f"{p['label']:<26} gap={round(point_gap)}ms  95% CI=[{round(lo)}, {round(hi)}]ms"
            f"{'  <-- CROSSES ZERO' if lo <= 0 <= hi else ''}"
        )

    with open(RESULTS_FILE, "w") as f:
        json.dump(
            {"rounds": ROUNDS, "warmup": WARMUP, "table": table, "gaps": gaps, "samples": samples},
            f,
            indent=2,
        )
    print(f"\nwrote {RESULTS_FILE}")

    ag.tracing.tracer_provider.force_flush()


if __name__ == "__main__":
    main()
