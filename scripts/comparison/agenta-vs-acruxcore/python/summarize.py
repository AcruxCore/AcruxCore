"""Recomputes the latency figures in "AcruxCore vs Agenta" from saved samples.

`latency_bench.py` writes every raw sample to a results file. This script reads
one or more of those files and prints, per run, each leg's median and p95 and
its median gap to the direct OpenRouter call with a 95% bootstrap confidence
interval. The post quotes these numbers, so anyone can recompute them from the
committed `reruns/results_run_*.json` files without calling a model.

Usage: python summarize.py reruns/results_run_1.json reruns/results_run_2.json ...
"""

import json
import math
import random
import sys

LEGS = [
    ("provider_direct", "OpenRouter direct"),
    ("agenta_traced", "Agenta traced SDK"),
    ("agenta_invoke", "Agenta invoke"),
    ("acx_gateway", "AcruxCore gateway"),
    ("acx_render_gateway", "AcruxCore render+gateway"),
]
RESAMPLES = 5000


def median(vals):
    s = sorted(vals)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def p95(vals):
    s = sorted(vals)
    return s[max(0, math.ceil(0.95 * len(s)) - 1)]


def gap_ci(baseline, other, rng):
    diffs = sorted(
        median([rng.choice(other) for _ in other]) - median([rng.choice(baseline) for _ in baseline])
        for _ in range(RESAMPLES)
    )
    return diffs[int(0.025 * RESAMPLES)], diffs[int(0.975 * RESAMPLES)]


def main(paths):
    # A fixed seed makes the printed intervals identical on every run of this script.
    rng = random.Random(42)
    for path in paths:
        with open(path) as f:
            samples = json.load(f)["samples"]
        base = samples["provider_direct"]
        print(f"== {path}")
        for key, label in LEGS:
            vals = samples[key]
            line = f"  {label:<26} n={len(vals)}  median={round(median(vals))}  p95={round(p95(vals))}"
            if key != "provider_direct":
                lo, hi = gap_ci(base, vals, rng)
                gap = median(vals) - median(base)
                line += f"  gap={round(gap):+d}  CI=[{round(lo):+d}, {round(hi):+d}]"
            print(line)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: python summarize.py results_run_1.json [results_run_2.json ...]")
    main(sys.argv[1:])
