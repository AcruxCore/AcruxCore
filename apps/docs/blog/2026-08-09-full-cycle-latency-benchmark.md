---
title: "Full-cycle latency across six LLM-ops platforms, measured against real OpenAI"
description: We timed prompt-fetch-plus-completion, not just the model call, across Opik, MLflow, Langfuse, Helicone, Phoenix, and AcruxCore's gateway and gateway-free BYOK modes, against a real OpenAI baseline — then ran it four times to see what's stable and what isn't.
slug: full-cycle-latency-benchmark
authors: [acrux]
tags: [performance, gateway, byok, comparison, opik, mlflow, langfuse, helicone, phoenix]
image: /img/social-card.png
keywords: [llm ops latency comparison, ai gateway latency, opik latency, mlflow ai gateway latency, langfuse latency, helicone latency, phoenix latency, byok latency, full cycle latency benchmark]
---

Every latency number we'd published before this measured one thing: the completion
call. But a real request to any of these platforms is usually two round trips —
fetch or resolve a stored prompt, **then** complete it — and most of them were
benchmarked against OpenRouter, not the provider whose name is on the model.

So this one measures the **full cycle**, on **real OpenAI billing**, across all six
platforms plus both of AcruxCore's calling modes — eight paths in one interleaved
run. We also ran it four independent times, because a single 100-round run against
a live third-party API turned out to not be enough to trust a single number, and
that's worth showing rather than hiding.

<!-- truncate -->

## The setup

All eight paths hit the same upstream — real `api.openai.com`, model `gpt-4o-mini`
— with the same prompt and parameters (`temperature: 0`, `max_tokens: 5`). Each
path does whatever that platform's stored-prompt feature actually requires (fetch
a prompt, resolve a template, or nothing, if the platform has no such concept),
then completes it, timed together as one number:

1. **OpenAI direct** — no platform in the loop. The baseline.
2. **Opik tracked SDK\*\*** — Opik's `track_openai()` wrapper around a direct call.
3. **MLflow AI Gateway\*\*** — routed through a local MLflow AI Gateway endpoint.
4. **Langfuse OTel SDK** — `langfuse.get_prompt()`, then a call instrumented with
   Langfuse's OpenTelemetry integration.
5. **Helicone AI Gateway** — routed through Helicone's AI Gateway.\*
6. **Phoenix OTel SDK** — a call instrumented with Arize Phoenix's OpenTelemetry
   integration.
7. **AcruxCore gateway** — `hub.prompts.render()`, then `hub.gateway.chat()`
   routed through AcruxCore's gateway.
8. **AcruxCore BYOK (gateway-free)** — the same render call, then
   `hub.gateway.chat()` with a `provider` config that posts to OpenAI directly,
   skipping the gateway. See
   [build a RAG agent without the gateway](/docs/tutorials/build-a-rag-agent-without-the-gateway)
   for the full BYO path.

Each run is **100 rounds plus 3 discarded warm-up rounds**, with the eight paths
**interleaved in rotating order** — the running order shifts every round, so no
path is always first and a passing network blip hits all eight equally.
Connections are pooled. We report **medians with a 95% bootstrap confidence
interval** (5,000 resamples) on the gap against the OpenAI baseline: if that
interval crosses zero, the gap isn't distinguishable from noise at this sample
size, and we say so rather than quoting the point estimate as if it were exact.

Full script:
[`full-cycle-latency-bench.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/shared/full-cycle-latency-bench.py).

## Median full-cycle latency, all eight paths

<figure>
<svg viewBox="0 0 720 392" role="img" aria-label="Median full-cycle latency in milliseconds: Opik tracked SDK (single merged message, see note) 810, MLflow AI Gateway (single merged message, see note) 902, Langfuse OTel SDK 954, Helicone AI Gateway 977, Phoenix OTel SDK 973, OpenAI direct baseline 978, AcruxCore BYOK 1022, AcruxCore gateway 1032" style="max-width:100%;height:auto;font-family:system-ui,sans-serif;font-size:14px">
  <line x1="180" y1="10" x2="180" y2="366" stroke="currentColor" stroke-opacity="0.25"/>
  <text x="170" y="42" text-anchor="end" fill="currentColor">Opik tracked SDK**</text>
  <rect x="180" y="26" width="365" height="26" rx="4" fill="#10a37f"/>
  <text x="555" y="44" fill="currentColor" font-weight="700">810 ms</text>
  <text x="170" y="86" text-anchor="end" fill="currentColor">MLflow AI Gateway**</text>
  <rect x="180" y="70" width="406" height="26" rx="4" fill="#10a37f"/>
  <text x="596" y="88" fill="currentColor" font-weight="700">902 ms</text>
  <text x="170" y="130" text-anchor="end" fill="currentColor">Langfuse OTel SDK</text>
  <rect x="180" y="114" width="429" height="26" rx="4" fill="#10a37f"/>
  <text x="619" y="132" fill="currentColor" font-weight="700">954 ms</text>
  <text x="170" y="174" text-anchor="end" fill="currentColor">Helicone AI Gateway*</text>
  <rect x="180" y="158" width="440" height="26" rx="4" fill="#10a37f"/>
  <text x="630" y="176" fill="currentColor" font-weight="700">977 ms</text>
  <text x="170" y="218" text-anchor="end" fill="currentColor">Phoenix OTel SDK</text>
  <rect x="180" y="202" width="438" height="26" rx="4" fill="#10a37f"/>
  <text x="628" y="220" fill="currentColor" font-weight="700">973 ms</text>
  <text x="170" y="262" text-anchor="end" fill="currentColor">OpenAI direct (baseline)</text>
  <rect x="180" y="246" width="440" height="26" rx="4" fill="#9ca3af"/>
  <text x="630" y="264" fill="currentColor" font-weight="700">978 ms</text>
  <text x="170" y="306" text-anchor="end" fill="currentColor">AcruxCore BYOK</text>
  <rect x="180" y="290" width="460" height="26" rx="4" fill="#6366f1"/>
  <text x="650" y="308" fill="currentColor" font-weight="700">1022 ms</text>
  <text x="170" y="350" text-anchor="end" fill="currentColor">AcruxCore gateway</text>
  <rect x="180" y="334" width="464" height="26" rx="4" fill="#6366f1"/>
  <text x="654" y="352" fill="currentColor" font-weight="700">1032 ms</text>
  <text x="180" y="382" fill="currentColor" fill-opacity="0.6" font-size="12px">0</text>
  <text x="630" y="382" text-anchor="middle" fill="currentColor" fill-opacity="0.6" font-size="12px">1000 ms</text>
</svg>
<figcaption>
<em>Median of 100 rounds, real OpenAI billing, most recent of four independent runs (raw data and all four runs' results are committed alongside the script).</em>
<br/>
<span style="display:inline-flex;gap:16px;align-items:center;margin-top:6px;font-size:12px;flex-wrap:wrap">
  <span style="display:inline-flex;gap:6px;align-items:center"><span style="width:10px;height:10px;border-radius:2px;background:#9ca3af;display:inline-block"></span> OpenAI direct (reference)</span>
  <span style="display:inline-flex;gap:6px;align-items:center"><span style="width:10px;height:10px;border-radius:2px;background:#10a37f;display:inline-block"></span> Other platform</span>
  <span style="display:inline-flex;gap:6px;align-items:center"><span style="width:10px;height:10px;border-radius:2px;background:#6366f1;display:inline-block"></span> AcruxCore</span>
</span>
</figcaption>
</figure>

All eight paths land within about 220ms of each other on the median — small next
to the ~600–800ms the model call itself takes. The tail tells a fuller story:

| Path | median | p95 | p99 |
|---|--:|--:|--:|
| Opik tracked SDK** | 810 ms | 1982 ms | 10999 ms |
| MLflow AI Gateway** | 902 ms | 1472 ms | 3370 ms |
| Langfuse OTel SDK | 954 ms | 1487 ms | 6002 ms |
| Helicone AI Gateway* | 977 ms | 1471 ms | 2166 ms |
| Phoenix OTel SDK | 973 ms | 1366 ms | 2695 ms |
| OpenAI direct (baseline) | 978 ms | 2706 ms | 6402 ms |
| AcruxCore BYOK (gateway-free) | 1022 ms | 1458 ms | 3688 ms |
| AcruxCore gateway | 1032 ms | 1676 ms | 3546 ms |

Notice the baseline's own p99 (6402ms) is worse than every platform's median and
most of their p99s — a reminder that raw OpenAI, with nothing in front of it, has
the widest tail here. That's normal live-network variance, not evidence any
platform is "faster than the provider it calls."

Median, p95, and p99 are still only three numbers standing in for 100 real
measurements each. Here's every one of those 800 rounds, plotted:

<figure>
<img src="/img/blog/full-cycle-latency-benchmark/01-all-platforms-distribution.png" alt="Box plot of all 100 measured rounds per leg, across all eight paths, with individual rounds jittered on top. Boxes show the median and interquartile range; a dashed line marks the OpenAI baseline's median. A handful of multi-second spikes per leg are capped at 4 seconds and marked with a triangle rather than hidden." style="max-width:100%;height:auto" />
<figcaption><em>Every measured round (not just the median), most recent of four independent runs. Generated from `results.json` by <a href="https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/shared/plot_latency_charts.py">plot_latency_charts.py</a>.</em></figcaption>
</figure>

The boxes overlap heavily — that's the point. Opik's box sits visibly lower than
the rest, which is what the negative gap in the next section is measuring; every
other platform's box straddles the baseline's dashed median line.

## Is any of this gap real?

A median alone doesn't tell you whether a platform costs something or whether
you're looking at noise. Bootstrapping the gap against the OpenAI baseline, per
round (so a shared network blip cancels out), gives a confidence interval:

| Platform | gap vs. OpenAI | 95% CI | statistically real? |
|---|--:|---|:--:|
| Opik tracked SDK** | −140 ms | [−287, −32] | Yes — doesn't cross zero |
| MLflow AI Gateway** | −81 ms | [−155, +34] | No |
| Langfuse OTel SDK | −22 ms | [−95, +84] | No |
| Helicone AI Gateway* | −6 ms | [−71, +111] | No |
| Phoenix OTel SDK | 0 ms | [−122, +101] | No |
| AcruxCore BYOK | +39 ms | [−1, +155] | No |
| AcruxCore gateway | +63 ms | [−19, +172] | No |

Only Opik's gap clears the zero line here, and it's negative — faster than the raw
baseline. Everything else, AcruxCore included, is statistically indistinguishable
from calling OpenAI with nothing in front of it, in this particular 100-round
sample.

Opik's negative gap isn't a one-run fluke: it shows up in all four independent
runs (−140ms to −168ms), and it's not a few outliers dragging the median either —
plotting every round against the same-round baseline shows Opik coming back
faster in 72–77% of individual rounds, every run:

<figure>
<img src="/img/blog/full-cycle-latency-benchmark/02-opik-vs-baseline-per-round.png" alt="Scatter plot of Opik tracked SDK versus OpenAI baseline latency, round by round, with a 9-round rolling median line for each. Opik's rolling median line sits below the baseline's for most of the run. Opik came back faster than the same-round baseline in 72 of 100 rounds." style="max-width:100%;height:auto" />
<figcaption><em>Raw round-by-round latency, most recent run — same round index means the same round of the interleaved benchmark. The rolling median makes the separation visible through the network noise. Same script as the chart above.</em></figcaption>
</figure>

That's a real, repeatable pattern. What it isn't, yet, is a fully explained one:
an isolated side-by-side test of the two candidate causes — Opik's prompt
rendering into a single merged message versus the baseline's separate
system/user messages, and the `track_openai()` wrapper itself — reproduced only a
small and inconsistent fraction of the gap, nowhere near its full size. The
honest state of this one: real effect, confirmed cause not yet found. We're not
going to publish a tidy explanation we haven't verified.

*\*Helicone's leg times completion only, not a real prompt fetch — its number is
directly comparable to the baseline's shape, not the other platforms'
two-round-trip cycles.*

:::note
\*\*Opik and MLflow store this prompt as flat text, not role-tagged chat
messages — confirmed against each platform's own stored data. So both send one
merged user message, not the system-plus-user split every other leg uses,
which makes neither a fully apples-to-apples structural comparison. That's
weaker evidence than it looks for "merged message causes the gap," though:
MLflow shares the exact same shape and its gap crosses zero — if the message
shape alone drove it, both should show it.
:::

## How stable is that gap, run to run?

Here's the part worth showing rather than skipping past: we ran the full
eight-path benchmark **four separate times**, on different occasions, with
identical code. Tracking AcruxCore's two modes against the OpenAI baseline across
all four runs:

<figure>
<svg viewBox="0 0 720 320" role="img" aria-label="AcruxCore gateway gap vs OpenAI baseline across four runs: +194ms, +53ms, 0ms, +63ms. AcruxCore BYOK gap, tested from run 2 onward: -8ms, -38ms, +39ms. All error bars are 95% confidence intervals; zero means statistically identical to raw OpenAI." style="max-width:100%;height:auto;font-family:system-ui,sans-serif;font-size:13px">
  <line x1="60" y1="20" x2="680" y2="20" stroke="currentColor" stroke-opacity="0.12"/>
  <text x="50" y="52" text-anchor="end" fill="currentColor" fill-opacity="0.6" font-size="12px">+200</text>
  <line x1="60" y1="48" x2="680" y2="48" stroke="currentColor" stroke-opacity="0.12"/>
  <text x="50" y="107" text-anchor="end" fill="currentColor" fill-opacity="0.6" font-size="12px">+100</text>
  <line x1="60" y1="103" x2="680" y2="103" stroke="currentColor" stroke-opacity="0.12"/>
  <text x="50" y="162" text-anchor="end" fill="currentColor" font-weight="700" font-size="12px">0</text>
  <line x1="60" y1="158" x2="680" y2="158" stroke="currentColor" stroke-opacity="0.4" stroke-dasharray="4 4"/>
  <text x="50" y="217" text-anchor="end" fill="currentColor" fill-opacity="0.6" font-size="12px">−100</text>
  <line x1="60" y1="213" x2="680" y2="213" stroke="currentColor" stroke-opacity="0.12"/>
  <line x1="138" y1="28" x2="138" y2="107" stroke="#6366f1" stroke-width="2"/>
  <line x1="293" y1="99" x2="293" y2="148" stroke="#6366f1" stroke-width="2"/>
  <line x1="448" y1="115" x2="448" y2="195" stroke="#6366f1" stroke-width="2"/>
  <line x1="603" y1="63" x2="603" y2="168" stroke="#6366f1" stroke-width="2"/>
  <polyline points="138,51 293,128 448,158 603,123" fill="none" stroke="#6366f1" stroke-width="2.5"/>
  <circle cx="138" cy="51" r="5" fill="#6366f1"/>
  <circle cx="293" cy="128" r="5" fill="#6366f1"/>
  <circle cx="448" cy="158" r="5" fill="#6366f1"/>
  <circle cx="603" cy="123" r="5" fill="#6366f1"/>
  <text x="138" y="38" text-anchor="middle" fill="#6366f1" font-weight="700" font-size="12px">+194</text>
  <text x="293" y="118" text-anchor="middle" fill="#6366f1" font-weight="700" font-size="12px">+53</text>
  <text x="448" y="148" text-anchor="middle" fill="#6366f1" font-weight="700" font-size="12px">0</text>
  <text x="623" y="126" text-anchor="middle" fill="#6366f1" font-weight="700" font-size="12px">+63</text>
  <line x1="293" y1="140" x2="293" y2="197" stroke="#d97706" stroke-width="2"/>
  <line x1="448" y1="137" x2="448" y2="224" stroke="#d97706" stroke-width="2"/>
  <line x1="603" y1="72" x2="603" y2="158" stroke="#d97706" stroke-width="2"/>
  <polyline points="293,162 448,178 603,136" fill="none" stroke="#d97706" stroke-width="2.5" stroke-dasharray="1 0"/>
  <rect x="288" y="157" width="10" height="10" fill="#d97706"/>
  <rect x="443" y="173" width="10" height="10" fill="#d97706"/>
  <rect x="598" y="131" width="10" height="10" fill="#d97706"/>
  <text x="293" y="235" text-anchor="middle" fill="#d97706" font-weight="700" font-size="12px">−8</text>
  <text x="448" y="251" text-anchor="middle" fill="#d97706" font-weight="700" font-size="12px">−38</text>
  <text x="603" y="87" text-anchor="middle" fill="#d97706" font-weight="700" font-size="12px">+39</text>
  <text x="138" y="290" text-anchor="middle" fill="currentColor">Run 1</text>
  <text x="293" y="290" text-anchor="middle" fill="currentColor">Run 2</text>
  <text x="448" y="290" text-anchor="middle" fill="currentColor">Run 3</text>
  <text x="603" y="290" text-anchor="middle" fill="currentColor">Run 4</text>
</svg>
<figcaption>
<em>Gap vs. OpenAI baseline (ms), four independent 100-round runs of identical code. Vertical bars are 95% bootstrap confidence intervals; the dashed line at zero is "statistically identical to raw OpenAI." AcruxCore BYOK wasn't yet a leg in Run 1.</em>
<br/>
<span style="display:inline-flex;gap:16px;align-items:center;margin-top:6px;font-size:12px;flex-wrap:wrap">
  <span style="display:inline-flex;gap:6px;align-items:center"><span style="width:10px;height:10px;border-radius:50%;background:#6366f1;display:inline-block"></span> AcruxCore gateway</span>
  <span style="display:inline-flex;gap:6px;align-items:center"><span style="width:10px;height:10px;background:#d97706;display:inline-block"></span> AcruxCore BYOK</span>
</span>
</figcaption>
</figure>

| Run | AcruxCore gateway gap | Crosses zero? | AcruxCore BYOK gap | Crosses zero? |
|---|--:|:--:|--:|:--:|
| Run 1 | +194 ms | No | — (not tested yet) | — |
| Run 2 | +53 ms | No | −8 ms | Yes |
| Run 3 | 0 ms | Yes | −38 ms | Yes |
| Run 4 | +63 ms | Yes | +39 ms | Yes |

The gateway's point estimate moves from +194ms down to 0ms and back to +63ms
across four runs of unchanged code — only two of the four even clear statistical
significance. **BYOK's gap crosses zero in every run it was measured.**

That difference is itself informative. A 100-round bootstrap on top of a highly
variable, 600–800ms live-network signal has real estimation width — commonly
±100–150ms per run at this sample size — which is enough to swallow a true
underlying effect of a few tens of milliseconds. A small, real, and stable cost
will still look like it's bouncing between 0 and 190ms across separate runs,
purely from sampling noise, even though nothing about the code changed between
them. **BYOK skips the gateway's synchronous work — a rate-limit check, a
budget-reserve transaction, and the request-persist step — while still recording
a trace asynchronously**, and that's the one number here that came back the same
every time we asked.

**The honest takeaway: if you need a single number for "how much does the
gateway cost," don't take one run's point estimate — the range across four runs
is closer to the truth than any one of them.** We're publishing all four runs'
raw data alongside the script for exactly that reason.

## What this means for you

- **All eight paths cluster within ~220ms of each other on the median** — small
  next to the ~600–800ms the model call itself takes.
- **Only one gap in this benchmark is consistently distinguishable from
  noise across runs**: Opik's client-side wrapper measured faster than raw
  OpenAI. Part of that leg also isn't a strict apples-to-apples comparison —
  Opik sends one merged message instead of the split system/user shape every
  other leg uses (see the \*\* note above) — but isolated testing found the
  message shape explains only a small part of the gap, not the cause.
- **AcruxCore's gateway adds a small cost that this method can't pin to an exact
  number** — somewhere in the tens of milliseconds, from synchronous DB work on
  the request path, but not stable enough across independent runs to quote as a
  fixed figure.
- **AcruxCore's BYOK mode is the one result that held up identically across every
  run**: statistically indistinguishable from calling OpenAI directly, while
  still reporting a trace. If you want the gateway's tracing and versioned
  prompts without its synchronous request-path work, that's the trade BYOK
  makes — see
  [route your calls through the gateway](/docs/guides/route-calls-through-the-gateway)
  for the other side of that choice.
- **Real third-party network latency is the dominant, most variable term in
  every path here** — hundreds of milliseconds and swings of a similar size,
  next to a local cost measured in the tens.

## Reproduce it

The script needs `OPENAI_API_KEY`, a personal AcruxCore API key, and local
instances of whichever of Opik / MLflow / Langfuse / Phoenix / Helicone you want
to include — it skips a platform cleanly if its env vars aren't set. Run it with
`python full-cycle-latency-bench.py`; it prints the summary table and the
bootstrap gap analysis to stdout, then writes `results.json`. Run it more than
once before trusting any single number, for the reason above.

Full script and all four runs' raw data:
[`scripts/comparison/shared/`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/shared/full-cycle-latency-bench.py)
on GitHub. Both charts above are generated straight from `results.json` by
[`plot_latency_charts.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/shared/plot_latency_charts.py)
in the same folder — point it at any run's `results.json` to regenerate them.

For the narrower question of what AcruxCore's own gateway costs against a BYO
call on the same machine, see
[how much overhead does an LLM gateway add?](/blog/llm-gateway-overhead)
