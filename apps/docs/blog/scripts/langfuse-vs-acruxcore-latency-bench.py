"""Interleaved latency benchmark backing "Langfuse vs AcruxCore" (aspect 8).

Same fixed prompt/model call ("Reply with the single word: pong.",
gpt-4o-mini on api.openai.com) measured three ways:

  provider_direct   raw HTTPS POST to api.openai.com/v1                  (baseline)
  langfuse_otel     langfuse.openai-wrapped OpenAI client -> OpenAI       (client-side
                    instrumentation cost)
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

Env vars: OPENAI_API_KEY, ACX_GATEWAY_KEY, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY,
and optionally ACX_BASE_URL (defaults to http://localhost:3001/api/v1) and
LANGFUSE_HOST (defaults to http://localhost:3050).

Usage: python langfuse-vs-acruxcore-latency-bench.py [rounds] [warmup]
Needs: pip install langfuse requests
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
ACX_BASE_URL = os.environ.get("ACX_BASE_URL", "http://localhost:3001/api/v1")
LANGFUSE_PUBLIC_KEY = os.environ.get("LANGFUSE_PUBLIC_KEY")
LANGFUSE_SECRET_KEY = os.environ.get("LANGFUSE_SECRET_KEY")
LANGFUSE_HOST = os.environ.get("LANGFUSE_HOST", "http://localhost:3050")
# Must resolve to a gateway model bound to a *native OpenAI* credential, so the
# gateway leg ends at the same host as the baseline. Enforced by the preflight
# below rather than trusted — the model name alone says nothing about which
# credential, and therefore which upstream host, it points at.
ACX_MODEL = os.environ.get("ACX_MODEL", "gpt-4o-mini")

OPENAI_MODEL = "gpt-4o-mini"

if not OPENAI_API_KEY:
    sys.exit("OPENAI_API_KEY is not set")
if not GATEWAY_KEY:
    sys.exit("ACX_GATEWAY_KEY is not set")
if not LANGFUSE_PUBLIC_KEY:
    sys.exit("LANGFUSE_PUBLIC_KEY is not set")
if not LANGFUSE_SECRET_KEY:
    sys.exit("LANGFUSE_SECRET_KEY is not set")

os.environ["LANGFUSE_PUBLIC_KEY"] = LANGFUSE_PUBLIC_KEY
os.environ["LANGFUSE_SECRET_KEY"] = LANGFUSE_SECRET_KEY
os.environ["LANGFUSE_HOST"] = LANGFUSE_HOST

# Imported only after the three vars above are in os.environ: the Langfuse SDK
# reads its credentials and host at import time, so importing it at the top of
# the file would bind a client that ignores whatever is set afterwards.
from langfuse.openai import openai  # noqa: E402


def assert_langfuse_ingest_works() -> None:
    """Exits unless the Langfuse credentials actually authenticate.

    Instrumentation SDKs are built not to break the host application, so a wrong
    or missing key does not raise — the wrapper still wraps the call, still builds
    the span, and still pays the client-side cost, while the background ingest
    quietly 401s. The benchmark would then report a number for a Langfuse that is
    not recording anything, which is not the setup the post describes.

    This is the same failure shape as the gateway-upstream check above: every call
    returns 200 and the only symptom is a number nobody can tell is wrong. So the
    credentials are verified against the API before any round is timed.
    """
    url = f"{LANGFUSE_HOST}/api/public/projects"
    try:
        res = requests.get(
            url, auth=(LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY), timeout=15
        )
    except requests.RequestException as exc:
        sys.exit(
            f"preflight failed: cannot reach Langfuse at {LANGFUSE_HOST} ({exc}).\n"
            f"  Start it, or point LANGFUSE_HOST at a running instance."
        )

    if res.status_code == 401:
        sys.exit(
            "preflight failed: Langfuse rejected LANGFUSE_PUBLIC_KEY/"
            "LANGFUSE_SECRET_KEY (401).\n"
            "  The SDK would still wrap each call and still cost client-side time, "
            "but every span would be dropped — so the run would time an "
            "instrumented path that records nothing."
        )
    if not res.ok:
        sys.exit(f"preflight failed: {url} returned {res.status_code}: {res.text[:200]}")

    projects = res.json().get("data", [])
    names = ", ".join(pr.get("name", "?") for pr in projects) or "(none)"
    print(f"preflight ok: Langfuse at {LANGFUSE_HOST} authenticated, projects: {names}")


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
assert_langfuse_ingest_works()

MESSAGES = [{"role": "user", "content": "Reply with the single word: pong."}]
BODY = {"messages": MESSAGES, "max_tokens": 5, "temperature": 0}

session = requests.Session()
langfuse_client = openai.OpenAI(api_key=OPENAI_API_KEY)


def provider_direct():
    res = session.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
        json={"model": OPENAI_MODEL, **BODY},
        timeout=30,
    )
    res.raise_for_status()
    res.json()


def langfuse_otel():
    langfuse_client.chat.completions.create(model=OPENAI_MODEL, **BODY)


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
    {"key": "langfuse_otel", "label": "Langfuse OTel SDK", "run": langfuse_otel},
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
