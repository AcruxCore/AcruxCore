---
title: "Exact-match gateway caching: latency and cost saved"
description: We measured the gateway's exact-match response cache against the calls it's built for — a ~100x latency drop on a hit, and zero cost, from a live run.
slug: exact-match-gateway-caching
authors: [acrux]
tags: [llm-gateway, llm-latency]
image: /img/social-card.png
keywords: [llm response caching, gateway cache, exact-match cache, reduce llm cost, reduce llm latency, cache hit rate]
---

A gateway virtual key can be given a cache window: set `cacheTtlSeconds` and
an **exact-match** repeat of a call — same model, same messages, same
`temperature`/`max_tokens`/`top_p`/`stop` — is served from Postgres instead
of the provider. We ran the same fixed set of prompts through it repeatedly
to see what a hit is actually worth, in milliseconds and in dollars.

<!-- truncate -->

## The setup

Fifteen distinct one-word-answer prompts, sent through `gpt-4o-mini` with
`temperature: 0` (the cache deliberately never stores a call with an
implicit or non-zero temperature — see the note below on why). Each of the
15 prompts was sent **four times**: the first send of a prompt is
necessarily a cache miss; the three repeats that follow are hits, since
nothing about the request changed. Sixty calls total, against a virtual key
created just for this run with a five-minute cache window, on a real running
gateway.

## The latency gap

<figure>
<svg viewBox="0 0 720 170" role="img" aria-label="Median and p95 latency, cache miss vs cache hit: miss median 902ms p95 2709ms, hit median 9ms p95 10ms" style="max-width:100%;height:auto;font-family:system-ui,sans-serif;font-size:14px">
  <text x="180" y="24" text-anchor="end" fill="currentColor">Miss — median</text>
  <rect x="184" y="8" width="451" height="24" rx="4" fill="#6366f1"/>
  <text x="643" y="26" fill="currentColor" font-weight="700">902 ms</text>
  <text x="180" y="58" text-anchor="end" fill="currentColor">Miss — p95</text>
  <rect x="184" y="42" width="536" height="24" rx="4" fill="#6366f1" fill-opacity="0.55"/>
  <text x="728" y="60" fill="currentColor" font-weight="700">2709 ms</text>
  <text x="180" y="102" text-anchor="end" fill="currentColor">Hit — median</text>
  <rect x="184" y="86" width="5" height="24" rx="2" fill="#10a37f"/>
  <text x="197" y="104" fill="currentColor" font-weight="700">9 ms</text>
  <text x="180" y="136" text-anchor="end" fill="currentColor">Hit — p95</text>
  <rect x="184" y="120" width="6" height="24" rx="2" fill="#10a37f" fill-opacity="0.7"/>
  <text x="198" y="138" fill="currentColor" font-weight="700">10 ms</text>
</svg>
<figcaption><em>60 calls, 15 unique prompts × 4 repeats, one live run, 1 August 2026. The p95 bar is truncated to keep the hit bars visible — see the table below for exact numbers.</em></figcaption>
</figure>

| | n | median | p95 |
|---|--:|--:|--:|
| Cache miss (real provider call) | 15 | 902 ms | 2709 ms |
| Cache hit (Postgres lookup) | 45 | 9 ms | 10 ms |

A hit is **about 100x faster** than a miss here, and its p95 is barely wider
than its median — that's the shape you'd expect from a single indexed
lookup versus a network round trip to a model provider, where the tail is
dominated by the provider's own variance, not the gateway's.

## The cost gap

The cache doesn't just skip the network call — it skips the bill. A hit's
`x-gateway-cost-usd` header reads `0`, and the gateway's own ledger records
`cache_hit` rows at zero cost rather than opening a spend-tracking
transaction at all:

| | calls | total cost |
|---|--:|--:|
| Misses (real spend) | 15 | $0.000063 |
| Hits (would-have-cost, at the measured miss rate) | 45 | $0.000189 |
| **Actual spend, this run** | 60 | **$0.000063** |

At this run's 1-in-4 duplicate rate, caching cut spend by **75%** — which is
just the duplicate share of the traffic (45 of 60 calls were repeats). The
absolute numbers above are tiny because `gpt-4o-mini` is cheap and the test
used 5-token replies; the *ratio* is what's portable. Route traffic through
the gateway where a meaningful share of calls repeat exactly — a support bot
answering the same handful of FAQs, a batch job re-processing overlapping
input — and that ratio is your cost reduction, whatever your real per-call
price is.

## What actually gets cached

The cache key is a hash of `model`, `messages` (in order), `temperature`,
`max_tokens`, `top_p`, and `stop` — nothing more, nothing less. A few
specifics worth knowing before you rely on it:

- **`temperature` must be explicitly `0`.** An omitted temperature is never
  cached, on purpose — the assumption is that if you didn't pin the
  temperature down, you don't want a stale answer standing in for a fresh
  sample.
- **Streaming calls are never cached**, on either side — a streamed request
  is never looked up and never stored.
- **The cache is per-team.** Two teams sending the identical request get
  two separate entries; nothing about a hit is shared across tenants.
- **It's still fully traced.** A hit writes the same span a miss would,
  tagged so you can tell them apart, and still shows the real token counts —
  only the cost is zero and no provider was actually called.

## What this means for you

- **Turn it on for a virtual key that serves repeat traffic** — the win
  scales with how often the *exact* same request recurs, not with volume on
  its own.
- **Pin `temperature: 0` deliberately** if you want caching — it's the one
  field the gateway insists on before it will store anything.
- **Cost savings equal your duplicate rate**, not a fixed percentage — this
  run's 75% came from sending each prompt four times; a lower repeat rate
  buys proportionally less.

:::note
Want to reproduce this? The exact numbers above come from one live run of
`gateway-cache-bench.mjs` against a running gateway — 15 fixed prompts, 4
passes each, a virtual key with `cacheTtlSeconds` set, reading the real
`x-gateway-cache` and `x-gateway-cost-usd` response headers rather than
inferring hit/miss from latency alone.
:::
