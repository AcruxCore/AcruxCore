"""Interleaved latency benchmark backing "Helicone vs AcruxCore" (aspect 8).

Same fixed prompt/model call ("Reply with the single word: pong.",
gpt-4o-mini on api.openai.com) measured on paths:

  provider_direct   raw HTTPS POST to api.openai.com/v1                  (baseline)
  helicone_gateway  POST to self-hosted Helicone's oai gateway proxy      (see note)
  acx_gateway       raw POST to a local AcruxCore gateway                (extra hop)

Every path ends at **api.openai.com**, with the same key, model and body, so the
model's own think time is a shared constant and whatever is left over is the path.
An earlier revision of this script put the baseline on openrouter.ai while the
gateway leg resolved to a model bound to a direct OpenAI credential — two
different hosts, which made the gateway look faster than the call it proxies.
`assert_gateway_upstream_matches_baseline()` now refuses to run unless ACX_MODEL
is bound to a native OpenAI credential, so that cannot recur silently. Rounds run
in a rotating order (not path-by-path) so a network blip hits all three equally,
and warm-up rounds are discarded before any sample is kept.

NOTE on the helicone_gateway leg — this used to fail every round, and the
reason was ours, not Helicone's. Its "AI Gateway" proxy forwards straight to
https://api.openai.com regardless of the BYOK provider key set in
Settings > Providers, and the earlier revision of this script sent it the
OpenRouter key the OpenRouter baseline used. OpenAI rejected every one of those
with "Incorrect API key", which the post then reported as a Helicone failure.
Now that all three legs are on a native OpenAI key, the leg is sent a key its
upstream actually accepts and is timed like any other.

Env vars: OPENAI_API_KEY, ACX_GATEWAY_KEY, optionally HELICONE_API_KEY, and
ACX_BASE_URL (defaults to http://localhost:3001/api/v1) and HELICONE_BASE_URL
(defaults to http://localhost:8585).

Usage: python latency_bench.py [rounds] [warmup]
Needs: pip install requests
"""

import json
import math
import os
import random
import sys
import time

import requests

ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 60
WARMUP = int(sys.argv[2]) if len(sys.argv) > 2 else 3

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
GATEWAY_KEY = os.environ.get("ACX_GATEWAY_KEY")
# Optional. The self-hosted AI Gateway route below proxies on the provider key alone;
# a Helicone key is what attributes a request to an organization so it gets *logged*.
# Without one the gateway still forwards and still returns 200 — it just records nothing,
# which makes the timing a floor for Helicone's real cost rather than the whole of it.
HELICONE_API_KEY = os.environ.get("HELICONE_API_KEY")
ACX_BASE_URL = os.environ.get("ACX_BASE_URL", "http://localhost:3001/api/v1")
# Must resolve to a gateway model bound to a *native OpenAI* credential, so the
# gateway leg ends at the same host as the baseline. Enforced by the preflight
# below rather than trusted — the model name alone says nothing about which
# credential, and therefore which upstream host, it points at.
ACX_MODEL = os.environ.get("ACX_MODEL", "gpt-4o-mini")

OPENAI_MODEL = "gpt-4o-mini"
HELICONE_BASE_URL = os.environ.get("HELICONE_BASE_URL", "http://localhost:8585")

if not OPENAI_API_KEY:
    sys.exit("OPENAI_API_KEY is not set")
if not GATEWAY_KEY:
    sys.exit("ACX_GATEWAY_KEY is not set")


def assert_gateway_upstream_matches_baseline() -> None:
    """Exits unless ACX_MODEL is bound to a native OpenAI credential.

    A gateway model is just a public name pointing at a credential, and the
    credential decides the upstream host. Two models named almost identically
    (`gpt-4o-mini` vs `gpt-4o-mini-or`) can therefore resolve to api.openai.com
    and openrouter.ai respectively. Comparing a gateway leg on one against a
    baseline on the other measures the distance between two providers, not the
    gateway's overhead, and it fails silently: every call returns 200 and the
    only symptom is an impossible number.

    `provider == "openai"` is the signal that matters. `openai_compatible` means
    a custom base_url — OpenRouter, Together, or any other relay — which would
    put the gateway leg on a different host from the baseline.
    """
    res = requests.get(
        f"{ACX_BASE_URL}/gateway/models",
        headers={"Authorization": f"Bearer {GATEWAY_KEY}"},
        timeout=15,
    )
    res.raise_for_status()
    models = res.json()

    match = next((m for m in models if m.get("publicName") == ACX_MODEL), None)
    if match is None:
        available = ", ".join(sorted(m.get("publicName", "?") for m in models))
        sys.exit(
            f"preflight failed: no gateway model named {ACX_MODEL!r}.\n"
            f"  available: {available}"
        )

    if match.get("provider") != "openai":
        sys.exit(
            f"preflight failed: gateway model {ACX_MODEL!r} is bound to credential "
            f"{match.get('credentialLabel')!r} (provider {match.get('provider')!r}), "
            f"not a native OpenAI credential.\n"
            f"  The baseline leg calls api.openai.com, so this leg would measure the "
            f"distance between two providers instead of the gateway's overhead.\n"
            f"  Point ACX_MODEL at a model bound to an OpenAI credential."
        )

    print(
        f"preflight ok: {ACX_MODEL!r} -> {match.get('upstreamModel')!r} "
        f"via {match.get('credentialLabel')!r} (provider {match.get('provider')!r}); "
        f"baseline -> api.openai.com/{OPENAI_MODEL}\n"
    )


assert_gateway_upstream_matches_baseline()

MESSAGES = [{"role": "user", "content": "Reply with the single word: pong."}]
BODY = {"messages": MESSAGES, "max_tokens": 5, "temperature": 0}

session = requests.Session()


def provider_direct():
    res = session.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
        json={"model": OPENAI_MODEL, **BODY},
        timeout=30,
    )
    res.raise_for_status()
    res.json()


def helicone_gateway():
    res = session.post(
        f"{HELICONE_BASE_URL}/v1/gateway/oai/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
        json={"model": "gpt-4o-mini", **BODY},
        timeout=30,
    )
    res.raise_for_status()
    res.json()


def acx_gateway():
    res = session.post(
        f"{ACX_BASE_URL}/gateway/chat/completions",
        headers={"Authorization": f"Bearer {GATEWAY_KEY}"},
        json={"model": ACX_MODEL, **BODY},
        timeout=30,
    )
    res.raise_for_status()
    res.json()


PATHS = [
    {"key": "provider_direct", "label": "OpenAI direct", "run": provider_direct},
    {"key": "helicone_gateway", "label": "Helicone AI Gateway", "run": helicone_gateway},
    {"key": "acx_gateway", "label": "AcruxCore gateway", "run": acx_gateway},
]

samples = {p["key"]: [] for p in PATHS}
failures = {p["key"]: 0 for p in PATHS}
last_error = {p["key"]: None for p in PATHS}


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
                    last_error[path["key"]] = str(err)[:150]

        if measured and (round_num - WARMUP + 1) % 10 == 0:
            done = round_num - WARMUP + 1
            parts = []
            for p in PATHS:
                s = samples[p["key"]]
                med = round(sorted(s)[len(s) // 2]) if s else "FAIL"
                parts.append(f"{p['key']}={med}")
            print(f"round {done}/{ROUNDS}  median  {'  '.join(parts)}")

    print("\n=== results ===")
    table = []
    for p in PATHS:
        s = sorted(samples[p["key"]])
        row = {
            "key": p["key"],
            "label": p["label"],
            "n": len(s),
            "failures": failures[p["key"]],
        }
        if s:
            row.update(
                {
                    "median": round(pct(s, 50)),
                    "p95": round(pct(s, 95)),
                    "p99": round(pct(s, 99)),
                    "min": round(s[0]),
                    "max": round(s[-1]),
                    "mean": round(sum(s) / len(s)),
                }
            )
            print(
                f"{p['label']:<22} n={row['n']} fail={row['failures']}  "
                f"median={row['median']}  p95={row['p95']}  p99={row['p99']}  "
                f"min={row['min']}  max={row['max']}"
            )
        else:
            print(
                f"{p['label']:<22} n=0 fail={row['failures']}  "
                f"NO SUCCESSFUL SAMPLES — last error: {last_error[p['key']]}"
            )
        table.append(row)

    with open("results.json", "w") as f:
        json.dump({"rounds": ROUNDS, "warmup": WARMUP, "table": table, "samples": samples}, f, indent=2)
    print("\nwrote results.json")

    print("\n=== median gap vs provider_direct (95% CI, 5000-resample bootstrap) ===")
    baseline = samples["provider_direct"]
    for p in PATHS:
        if p["key"] == "provider_direct":
            continue
        other = samples[p["key"]]
        if not other:
            print(f"{p['label']:<22} skipped — zero successful samples, nothing to compare")
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
            f"{p['label']:<22} gap={round(point_gap)}ms  "
            f"95% CI=[{round(lo)}, {round(hi)}]ms"
            f"{'  <-- CROSSES ZERO: not statistically distinguishable' if crosses_zero else ''}"
        )


if __name__ == "__main__":
    main()
