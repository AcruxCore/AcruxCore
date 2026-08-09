"""Renders the two raster charts used in the full-cycle latency blog post
(apps/docs/blog/2026-08-09-full-cycle-latency-benchmark.md) directly from the
raw per-round samples in `results.json` — no hand-drawn numbers.

Chart 1, `01-all-platforms-distribution.png`: every one of the 100 measured
rounds for all 8 legs, as a box plot (median/IQR/whiskers) with the individual
rounds jittered on top. The bar chart elsewhere in the post shows only the
median; this is what that median is standing in for, and how much it hides.

Chart 2, `02-opik-vs-baseline-per-round.png`: `opik_tracked` plotted against
`openai_baseline` round-by-round (same round index = same round, both legs run
in the same interleaved pass), plus a rolling median of each to make the
separation visible through the raw network noise.

Colors reuse the exact hexes already validated (dataviz skill, light+dark) for
this post's hand-drawn SVG charts: gray for the baseline, green for the other
five platforms, indigo/amber for AcruxCore's two modes.

Usage: python plot_latency_charts.py [path/to/results.json] [output_dir]
Needs: pip install matplotlib
"""

import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

RESULTS_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "results.json"
OUT_DIR = (
    Path(sys.argv[2])
    if len(sys.argv) > 2
    else Path(__file__).parents[3] / "apps/docs/static/img/blog/full-cycle-latency-benchmark"
)

GRAY = "#9ca3af"
GREEN = "#10a37f"
INDIGO = "#6366f1"
AMBER = "#d97706"
INK = "#374151"

# key -> (display label, color). Order matches the rest of the post's tables.
# Labels carry the same *  / ** footnote markers used in the post's prose:
#   *  Helicone — completion-only leg, no real prompt fetch.
#   ** Opik / MLflow — prompt stored as flat text, sent as one merged user
#      message instead of a separate system + user message like the other six.
LEGS = [
    ("openai_baseline", "OpenAI\n(baseline)", GRAY),
    ("opik_tracked", "Opik**", GREEN),
    ("mlflow_gateway", "MLflow**", GREEN),
    ("langfuse_otel", "Langfuse", GREEN),
    ("helicone_gateway", "Helicone*", GREEN),
    ("phoenix_otel", "Phoenix", GREEN),
    ("acx_byok", "AcruxCore\nBYOK", AMBER),
    ("acx_gateway", "AcruxCore\ngateway", INDIGO),
]


def load_samples():
    with open(RESULTS_PATH) as f:
        data = json.load(f)
    return data["samples"]


Y_CAP = 4000  # ms — a handful of rare multi-second network spikes go above this


def plot_distribution(samples):
    fig, ax = plt.subplots(figsize=(9.6, 5.4), dpi=150)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    positions = list(range(1, len(LEGS) + 1))
    box_data = [samples[key] for key, _, _ in LEGS]

    bp = ax.boxplot(
        box_data,
        positions=positions,
        widths=0.5,
        patch_artist=True,
        showfliers=False,
        medianprops={"color": INK, "linewidth": 2},
        whiskerprops={"color": INK, "linewidth": 1.2},
        capprops={"color": INK, "linewidth": 1.2},
        boxprops={"linewidth": 1.2},
    )
    for patch, (_, _, color) in zip(bp["boxes"], LEGS):
        patch.set_facecolor(color)
        patch.set_alpha(0.35)
        patch.set_edgecolor(color)

    capped_total = 0
    for i, (key, _, color) in enumerate(LEGS):
        vals = samples[key]
        # deterministic jitter (no randomness dependency beyond a fixed seed)
        jitter = [((j * 2654435761) % 1000) / 1000 - 0.5 for j in range(len(vals))]
        xs_in = [positions[i] + 0.28 * jx for j, jx in enumerate(jitter) if vals[j] <= Y_CAP]
        ys_in = [v for v in vals if v <= Y_CAP]
        ax.scatter(xs_in, ys_in, s=8, color=color, alpha=0.35, linewidths=0, zorder=3)

        capped = [(positions[i] + 0.28 * jitter[j]) for j, v in enumerate(vals) if v > Y_CAP]
        capped_total += len(capped)
        if capped:
            ax.scatter(
                capped,
                [Y_CAP * 0.985] * len(capped),
                marker="^",
                s=26,
                color=color,
                edgecolors=INK,
                linewidths=0.6,
                zorder=4,
            )

    baseline_median = sorted(samples["openai_baseline"])[len(samples["openai_baseline"]) // 2]
    ax.axhline(baseline_median, color=GRAY, linestyle="--", linewidth=1, zorder=1, alpha=0.7)
    ax.text(
        len(LEGS) + 0.55,
        baseline_median,
        f"baseline median\n{round(baseline_median)}ms",
        color=GRAY,
        fontsize=8,
        va="center",
        ha="left",
    )

    ax.set_xticks(positions)
    ax.set_xticklabels([label for _, label, _ in LEGS], fontsize=9, color=INK)
    ax.set_ylabel("Full-cycle latency (ms)", color=INK, fontsize=10)
    ax.set_ylim(0, Y_CAP)
    ax.set_title(
        "All 100 measured rounds per leg — not just the median",
        color=INK,
        fontsize=12,
        loc="left",
        pad=12,
    )
    ax.text(
        0.55,
        Y_CAP * 0.965,
        f"▲ {capped_total} rounds (of 800) spiked past {Y_CAP//1000}s — capped here, not hidden; see results.json for exact values",
        color=INK,
        fontsize=7.5,
        alpha=0.75,
        va="top",
    )
    ax.spines[["top", "right"]].set_visible(False)
    ax.spines[["left", "bottom"]].set_color("#d1d5db")
    ax.tick_params(colors=INK, length=0)
    ax.grid(axis="y", color="#e5e7eb", linewidth=0.8, zorder=0)
    ax.set_axisbelow(True)
    ax.set_xlim(0.3, len(LEGS) + 1.3)

    fig.tight_layout()
    out = OUT_DIR / "01-all-platforms-distribution.png"
    fig.savefig(out, facecolor="white")
    plt.close(fig)
    print(f"wrote {out} ({capped_total} points capped)")


def rolling_median(vals, window=9):
    half = window // 2
    out = []
    for i in range(len(vals)):
        lo, hi = max(0, i - half), min(len(vals), i + half + 1)
        window_vals = sorted(vals[lo:hi])
        out.append(window_vals[len(window_vals) // 2])
    return out


def plot_opik_vs_baseline(samples):
    baseline = samples["openai_baseline"]
    opik = samples["opik_tracked"]
    n = min(len(baseline), len(opik))
    rounds = list(range(1, n + 1))

    faster_count = sum(1 for i in range(n) if opik[i] < baseline[i])

    fig, ax = plt.subplots(figsize=(9.6, 4.8), dpi=150)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    cap = Y_CAP
    baseline_in = [(r, v) for r, v in zip(rounds, baseline[:n]) if v <= cap]
    opik_in = [(r, v) for r, v in zip(rounds, opik[:n]) if v <= cap]
    baseline_capped = [r for r, v in zip(rounds, baseline[:n]) if v > cap]
    opik_capped = [r for r, v in zip(rounds, opik[:n]) if v > cap]

    ax.scatter(*zip(*baseline_in), s=14, color=GRAY, alpha=0.45, linewidths=0, label="OpenAI baseline (raw round)")
    ax.scatter(*zip(*opik_in), s=14, color=GREEN, alpha=0.45, linewidths=0, label="Opik tracked SDK** (raw round)")
    if baseline_capped:
        ax.scatter(baseline_capped, [cap * 0.97] * len(baseline_capped), marker="^", s=40, color=GRAY, edgecolors=INK, linewidths=0.6, zorder=4)
    if opik_capped:
        ax.scatter(opik_capped, [cap * 0.97] * len(opik_capped), marker="^", s=40, color=GREEN, edgecolors=INK, linewidths=0.6, zorder=4)
    ax.plot(rounds, rolling_median(baseline[:n]), color=GRAY, linewidth=2.2, label="OpenAI baseline (9-round rolling median)")
    ax.plot(rounds, rolling_median(opik[:n]), color=GREEN, linewidth=2.2, label="Opik tracked SDK** (9-round rolling median)")

    ax.set_ylim(0, cap)
    ax.set_xlabel("Round (same round index = same round, interleaved run)", color=INK, fontsize=9)
    ax.set_ylabel("Full-cycle latency (ms)", color=INK, fontsize=10)
    ax.set_title(
        f"Opik came back faster than the same-round baseline in {faster_count}/{n} rounds ({round(100*faster_count/n)}%)",
        color=INK,
        fontsize=11.5,
        loc="left",
        pad=12,
    )
    if baseline_capped or opik_capped:
        ax.text(
            2,
            cap * 0.9,
            f"▲ {len(baseline_capped) + len(opik_capped)} rounds spiked past {cap//1000}s — capped, not hidden; see results.json",
            color=INK,
            fontsize=7.5,
            alpha=0.75,
            va="top",
        )
    ax.spines[["top", "right"]].set_visible(False)
    ax.spines[["left", "bottom"]].set_color("#d1d5db")
    ax.tick_params(colors=INK, length=0)
    ax.grid(axis="y", color="#e5e7eb", linewidth=0.8, zorder=0)
    ax.set_axisbelow(True)
    ax.legend(frameon=False, fontsize=8, loc="upper right", labelcolor=INK)

    fig.tight_layout()
    out = OUT_DIR / "02-opik-vs-baseline-per-round.png"
    fig.savefig(out, facecolor="white")
    plt.close(fig)
    print(f"wrote {out} ({faster_count}/{n} rounds faster)")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    samples = load_samples()
    plot_distribution(samples)
    plot_opik_vs_baseline(samples)


if __name__ == "__main__":
    main()
