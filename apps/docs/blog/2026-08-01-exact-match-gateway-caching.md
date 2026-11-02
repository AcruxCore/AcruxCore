---
title: "Exact-match gateway caching: latency and cost saved"
description: "We measured the gateway's exact-match response cache in one live run: a 9 ms median on a hit against 902 ms for a provider call, and zero cost per hit."
slug: exact-match-gateway-caching
authors: [acrux]
tags: [llm-gateway, llm-latency]
image: /img/blog/exact-match-gateway-caching/header.webp
keywords: [llm response caching, gateway cache, exact-match cache, reduce llm cost, reduce llm latency, cache hit rate]
last_update:
  date: 2026-11-02
---

![A call on a virtual key with a cache window goes through the gateway; an exact repeat is a cache hit served by a Postgres lookup, anything else is a cache miss and a real provider call; the model, messages, temperature and tools must all match](/img/blog/exact-match-gateway-caching/header.webp)

A cache hit in the AcruxCore gateway returned in a median of **9 ms**, against
**902 ms** for the same call sent to the provider, and it cost $0. The test sent each of
15 prompts four times, so 3 of every 4 calls were repeats, and caching cut spend by 75%.

A gateway [virtual key](https://docs.acruxcore.com/docs/guides/scope-access-with-virtual-keys)
can be given a cache window: set
[`cacheTtlSeconds`](https://docs.acruxcore.com/api-reference/gateway/keys) and
an **exact-match** repeat of a call — same model, same messages, same sampling
parameters, tools and response format — is served from Postgres instead
of the provider. We ran the same fixed set of prompts through it repeatedly
to see what a hit is actually worth, in milliseconds and in dollars.

<!-- truncate -->

## The setup

Fifteen distinct one-word-answer prompts, sent through `gpt-4o-mini` with
`temperature: 0`. The cache never stores a call with an omitted or non-zero
temperature, for the reason given below. Each of the 15 prompts was sent **four
times**. The first send of a prompt is a cache miss, and the three repeats that
follow are hits, because nothing in the request changed. That is 60 calls in
total, on a virtual key created for this run with a five-minute cache window.

- **Date:** 1 August 2026.
- **Gateway host, region, Postgres location and gateway version:** not recorded.
  The benchmark script's default base URL is `http://localhost:3001/api/v1`, and
  `ACRUXCORE_BASE_URL` points it at another gateway.

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

In this one run, a hit took 9 ms at the median and a miss 902 ms. The hit's p95
(10 ms) is close to its median, which fits a single indexed lookup. The miss's
tail comes from the provider. Because the gateway's host was not recorded, the
9 ms says how fast a lookup was here, not how fast it will be on your setup.

## The cost gap

A hit also skips the bill. Its `x-gateway-cost-usd` header reads `0`, and the
gateway's ledger records `cache_hit` rows at zero cost without opening a
spend-tracking transaction:

| | calls | total cost |
|---|--:|--:|
| Misses (real spend) | 15 | $0.000063 |
| Hits (what they would have cost at the average cost of a miss) | 45 | $0.000189 |
| **Actual spend, this run** | 60 | **$0.000063** |

At this run's 3-in-4 duplicate rate, caching cut spend by **75%**, which is the
duplicate share of the traffic (45 of 60 calls were repeats). The dollar amounts
are tiny because `gpt-4o-mini` is cheap and the test used 5-token replies, so the
ratio is the number to carry over. Where a share of your calls repeat exactly, such
as a support bot answering the same few questions or a batch job that re-processes
overlapping input, that share is your cost reduction, whatever your per-call price.

## What actually gets cached

The cache key is a hash of `model`, `messages` (in order), `temperature`,
`max_tokens`, `top_p`, `stop`, `response_format`, `tools`, `tool_choice` and,
when set, `reasoning_effort`. A call that differs in any one of these is a
separate cache entry. Because the whole message list is in the key, a hit needs
the exact same conversation. For a long system prompt that repeats with different
user messages, use the provider's prompt caching, which the gateway passes through.
A few specifics worth knowing before you rely on it:

- **`temperature` must be explicitly `0`.** An omitted temperature is never
  cached, on purpose. If you did not set the temperature, the gateway assumes
  you want a fresh sample, not a stored answer.
- **Streaming calls are never cached.** A streamed request is never looked up
  in the cache, and its reply is never stored.
- **The cache is per-team.** Two teams sending the identical request get
  two separate entries; nothing about a hit is shared across tenants.
- **A hit is still traced.** It writes the same span a miss would, tagged so
  you can tell them apart, with the real token counts. Only the cost is zero,
  and no provider is called.

> **Key point:** An exact-match cache pays off only for traffic that repeats word for word, with
> pinned sampling settings. The saving equals the share of calls that repeat.

## Which kind of cache to use

Three kinds of caching come up for LLM calls. This post measured only the first.

![Three kinds of cache: the exact-match response cache in this gateway needs the whole request to match and saves the whole call but can go stale; provider prompt caching matches a repeated prefix, saves input cost and is always fresh; a semantic cache matches similar meaning and saves the whole call but can return a wrong stored answer](/img/blog/exact-match-gateway-caching/cache-kinds.webp)

| Cache | What must match | What you save | Risk |
|---|---|---|---|
| Exact-match response cache (this gateway) | The whole request: model, every message, sampling settings, tools | The whole call: no provider call, $0 | None for the same request at `temperature: 0`; an answer can go stale within the cache window |
| Provider prompt caching | A repeated prefix, such as a long system prompt | Part of the input cost; the model still runs | The reply is always fresh |
| Semantic cache | A request with a similar meaning, by embedding similarity | The whole call | A similar but different question can get the wrong stored answer |

The AcruxCore gateway has the first kind and passes the second through to the
provider. It has no semantic cache.

## What this means for you

- **Turn it on for a virtual key that serves repeat traffic.** The saving grows
  with how often the exact same request comes back, not with volume alone.
- **Set `temperature: 0`** if you want caching. The gateway stores nothing
  without it.
- **The cost saving equals your duplicate rate**, not a fixed percentage. This
  run's 75% came from sending each prompt four times, and a lower repeat rate
  saves proportionally less.

:::note
The numbers above come from one live run of `gateway-cache-bench.mjs`: 15 fixed
prompts, 4 passes each, on a virtual key with `cacheTtlSeconds` set. The script
reads the `x-gateway-cache` and `x-gateway-cost-usd` response headers, so a hit
or a miss is not guessed from latency.
:::

## FAQ

### What is an exact-match LLM cache?

It stores a model's reply and returns it when the exact same request comes back.
In the AcruxCore gateway, the key covers the model, the messages in order, the
sampling settings, `tools`, `tool_choice` and `response_format`.

### How much faster is a cache hit?

In our one run, a hit took a median of 9 ms and a call to the provider 902 ms.
The gateway's host was not recorded, so treat the 9 ms as one measurement.

### How much does LLM response caching save?

The saving equals the share of calls that repeat exactly. In our test, 3 of every
4 calls repeated and spend fell by 75%.

### Does temperature affect caching?

Yes. The AcruxCore gateway caches a call only when `temperature` is explicitly
`0`, and an omitted temperature is never cached.

### Are streamed calls cached?

No. A streamed request is never looked up in the cache, and its reply is never
stored.

### What is the difference between exact-match and semantic caching?

An exact-match cache returns a stored reply only for the identical request. A
semantic cache also returns one for a request with a similar meaning, which can
give a wrong answer to a different question. The AcruxCore gateway has no
semantic cache.

:::github
[`gateway-cache-bench.mjs`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/blogs/exact-match-gateway-caching/typescript/gateway-cache-bench.mjs) — the cache benchmark.
:::
