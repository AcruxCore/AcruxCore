"""Interleaved latency benchmark backing "Opik vs AcruxCore" (aspect 8).

Same fixed prompt/model call ("Reply with the single word: pong.",
openai/gpt-4o-mini via OpenRouter) measured three ways:

  provider_direct   raw HTTPS POST to openrouter.ai/api/v1                (baseline)
  opik_tracked      opik.integrations.openai.track_openai-wrapped client  (client-side
                    instrumentation cost, same shape as Langfuse's wrapper)
  acx_gateway       raw POST to a local AcruxCore gateway                (extra hop)

Every path ends at the same upstream, same key, same body, so the model's own think
time is a shared constant and whatever is left over is the path. Rounds run in a
rotating order (not path-by-path) so a network blip hits all three equally, and a
warm-up round is discarded before any sample is kept.

Env vars: OPENROUTER_KEY, ACX_GATEWAY_KEY, and optionally ACX_BASE_URL (defaults to
http://localhost:3001/api/v1), OPIK_URL_OVERRIDE (defaults to
http://localhost:5175/api for a local self-hosted Opik).

Usage: python latency_bench.py [rounds] [warmup]
Needs: pip install opik openai requests
"""

import json
import math
import os
import random
import sys
import time

import requests

os.environ.setdefault("OPIK_URL_OVERRIDE", "http://localhost:5175/api")
os.environ.setdefault("OPIK_WORKSPACE", "default")
os.environ.setdefault("OPIK_PROJECT_NAME", "Default Project")

from opik.integrations.openai import track_openai
from openai import OpenAI

ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 60
WARMUP = int(sys.argv[2]) if len(sys.argv) > 2 else 3

OPENROUTER_KEY = os.environ.get("OPENROUTER_KEY")
GATEWAY_KEY = os.environ.get("ACX_GATEWAY_KEY")
ACX_BASE_URL = os.environ.get("ACX_BASE_URL", "http://localhost:3001/api/v1")

if not OPENROUTER_KEY:
    sys.exit("OPENROUTER_KEY is not set")
if not GATEWAY_KEY:
    sys.exit("ACX_GATEWAY_KEY is not set")

MESSAGES = [{"role": "user", "content": "Reply with the single word: pong."}]
BODY = {"messages": MESSAGES, "max_tokens": 5, "temperature": 0}

session = requests.Session()
opik_client = track_openai(
    OpenAI(api_key=OPENROUTER_KEY, base_url="https://openrouter.ai/api/v1"),
    project_name=os.environ["OPIK_PROJECT_NAME"],
)


def provider_direct():
    res = session.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENROUTER_KEY}"},
        json={"model": "openai/gpt-4o-mini", **BODY},
        timeout=30,
    )
    res.raise_for_status()
    res.json()


def opik_tracked():
    opik_client.chat.completions.create(model="openai/gpt-4o-mini", **BODY)


def acx_gateway():
    res = session.post(
        f"{ACX_BASE_URL}/gateway/chat/completions",
        headers={"Authorization": f"Bearer {GATEWAY_KEY}"},
        json={"model": "gpt-4o-mini", **BODY},
        timeout=30,
    )
    res.raise_for_status()
    res.json()


PATHS = [
    {"key": "provider_direct", "label": "OpenRouter direct", "run": provider_direct},
    {"key": "opik_tracked", "label": "Opik tracked SDK", "run": opik_tracked},
    {"key": "acx_gateway", "label": "AcruxCore gateway", "run": acx_gateway},
]

samples = {p["key"]: [] for p in PATHS}
failures = {p["key"]: 0 for p in PATHS}


def pct(sorted_vals, p):
    if not sorted_vals:
        return float("nan")
    i = min(len(sorted_vals) - 1, math.ceil((p / 100) * len(sorted_vals)) - 1)
    return sorted_vals[max(0, i)]


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
                f"{p['key']}={round(sorted(samples[p['key']])[len(samples[p['key']]) // 2])}"
                for p in PATHS
            )
            print(f"round {done}/{ROUNDS}  median  {line}")

    print("\n=== results ===")
    table = []
    for p in PATHS:
        s = sorted(samples[p["key"]])
        row = {
            "key": p["key"],
            "label": p["label"],
            "n": len(s),
            "failures": failures[p["key"]],
            "median": round(pct(s, 50)),
            "p95": round(pct(s, 95)),
            "p99": round(pct(s, 99)),
            "min": round(s[0]),
            "max": round(s[-1]),
            "mean": round(sum(s) / len(s)),
        }
        table.append(row)
        print(
            f"{p['label']:<20} n={row['n']} fail={row['failures']}  "
            f"median={row['median']}  p95={row['p95']}  p99={row['p99']}  "
            f"min={row['min']}  max={row['max']}"
        )

    with open("results.json", "w") as f:
        json.dump({"rounds": ROUNDS, "warmup": WARMUP, "table": table, "samples": samples}, f, indent=2)
    print("\nwrote results.json")

    print("\n=== median gap vs provider_direct (95% CI, 5000-resample bootstrap) ===")
    baseline = samples["provider_direct"]
    for p in PATHS:
        if p["key"] == "provider_direct":
            continue
        other = samples[p["key"]]
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
            f"{p['label']:<20} gap={round(point_gap)}ms  "
            f"95% CI=[{round(lo)}, {round(hi)}]ms"
            f"{'  <-- CROSSES ZERO: not statistically distinguishable' if crosses_zero else ''}"
        )


if __name__ == "__main__":
    main()
