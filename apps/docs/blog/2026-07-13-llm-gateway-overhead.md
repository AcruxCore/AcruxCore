---
title: "How much overhead does an LLM gateway add?"
description: We benchmarked five ways to reach the same OpenAI model — gateway, BYOK, and raw. The gateway's own code added no measurable time; the rest is network distance.
slug: llm-gateway-overhead
authors: [acrux]
tags: [llm-gateway, llm-latency]
image: /img/social-card.png
keywords: [llm gateway latency, ai gateway overhead, openai proxy latency, byok latency, AcruxCore gateway, llm ops performance]
last_update:
  date: 2026-10-25
---

An AcruxCore gateway running on the same machine as your app added a median of
**9 ms** to an OpenAI call that takes about 640 ms. The 95% confidence interval
runs from −15 ms to +28 ms, so this test cannot tell the gateway apart from a
direct call. Calling OpenAI with your own key through the SDK, with no gateway,
also adds nothing measurable, with tracing on or off.

A gateway gives you one endpoint for every provider, cost accounting, caching,
virtual keys, and budgets, and it also adds a network hop. We measured five ways
to reach the same model — through our gateway, around it with your own key, and
raw — to see where the milliseconds go.

<!-- truncate -->

## The setup

The trick to a fair latency test is holding everything constant except the thing
you're measuring. All five paths below hit the **same upstream** — OpenAI
`gpt-4o-mini` — using the **same OpenAI account and key**, with the **exact same
prompt** and parameters:

```json
{
  "model": "gpt-4o-mini",
  "messages": [{ "role": "user", "content": "Reply with the single word: pong." }],
  "max_tokens": 5,
  "temperature": 0
}
```

Because every path ends at the same OpenAI model, the model's own response time is
a shared constant across all five. Whatever difference is left over is the path.

The five paths:

1. **OpenAI direct** — call `api.openai.com` straight from the test machine. The
   baseline.
2. **BYO, tracing off** — the SDK's `hub.gateway.chat()` with a `provider` config, which posts
   to OpenAI directly and skips our gateway, with auto-tracing switched off.
3. **BYO, tracing on** — the same call with the SDK's *default* tracing, which
   reports a trace to AcruxCore after the model answers.
4. **Local gateway** — the same call through an AcruxCore gateway running on the
   test machine, which forwards to OpenAI.
5. **Hosted gateway** — the same call through our hosted gateway at
   `api.acruxcore.com`, which forwards to OpenAI.

Each path ran **60 interleaved rounds** (the paths take turns, and the running
order rotates every round, so no path is always first and a passing network blip
hits all five equally), after a warm-up we discarded. Connections were pooled. The
local gateway ran a **production build**, not a dev server. We report **medians
with a 95% confidence interval**, and the **p95/p99 tails** — averages hide the
spikes that actually annoy users.

## The five paths, side by side

<figure>
<svg viewBox="0 0 720 250" role="img" aria-label="Median latency by path, 25 October 2026: BYO tracing on 621 ms, Local gateway 632 ms, BYO no trace 634 ms, OpenAI direct 639 ms, Hosted gateway 1176 ms" style="max-width:100%;height:auto;font-family:system-ui,sans-serif;font-size:14px">
  <line x1="180" y1="18" x2="180" y2="222" stroke="currentColor" stroke-opacity="0.25"/>
  <text x="170" y="42" text-anchor="end" fill="currentColor">BYO, tracing on</text>
  <rect x="180" y="26" width="204" height="26" rx="4" fill="#10a37f"/>
  <text x="394" y="44" fill="currentColor" font-weight="700">621 ms</text>
  <text x="170" y="86" text-anchor="end" fill="currentColor">Local gateway</text>
  <rect x="180" y="70" width="208" height="26" rx="4" fill="#6366f1"/>
  <text x="398" y="88" fill="currentColor" font-weight="700">632 ms</text>
  <text x="170" y="130" text-anchor="end" fill="currentColor">BYO, no trace</text>
  <rect x="180" y="114" width="209" height="26" rx="4" fill="#10a37f"/>
  <text x="399" y="132" fill="currentColor" font-weight="700">634 ms</text>
  <text x="170" y="174" text-anchor="end" fill="currentColor">OpenAI direct</text>
  <rect x="180" y="158" width="210" height="26" rx="4" fill="#10a37f"/>
  <text x="400" y="176" fill="currentColor" font-weight="700">639 ms</text>
  <text x="170" y="218" text-anchor="end" fill="currentColor">Hosted gateway</text>
  <rect x="180" y="202" width="387" height="26" rx="4" fill="#6366f1"/>
  <text x="577" y="220" fill="currentColor" font-weight="700">1176 ms</text>
  <text x="180" y="242" fill="currentColor" fill-opacity="0.6" font-size="12px">0</text>
  <text x="509" y="242" text-anchor="middle" fill="currentColor" fill-opacity="0.6" font-size="12px">1000 ms</text>
</svg>
<figcaption><em>Median of 60 interleaved rounds, 25 October 2026. Green bars skip the gateway; purple bars go through it.</em></figcaption>
</figure>

Four bars sit between 620 and 640 ms: OpenAI direct, both BYO variants, and the
local gateway. Only the hosted gateway sits further out. The rest of this post
explains both results.

## The gateway's own code adds no measurable time

Start with the clean comparison — OpenAI direct versus the same call through a
gateway on the same machine. Same machine means the gateway's call to OpenAI
travels the *identical* network path as the direct baseline, so the gap between
them is purely the gateway's own code.

Because the paths run in the same round, we can subtract them **per round**, which
cancels any blip they shared:

| comparison | median gap | 95% confidence interval |
|---|--:|---|
| Local gateway − OpenAI direct | **+9 ms** | −15 ms to +28 ms |

The interval crosses zero. Routing, resolving your model name, applying your key,
recording the call, and accounting the cost add no time that 60 rounds can
separate from network noise. The upper bound is **28 ms**, under 5% of a ~640 ms
call. The gap moves by tens of milliseconds from one run to the next, so read the
interval, not the single median.

## Skipping the gateway doesn't make the call faster

Hand the SDK a `provider` config and it posts to OpenAI directly — your provider
key never reaches our servers, and there is no hop:

```ts
const result = await hub.gateway.chat({
  model: 'gpt-4o-mini',
  messages,
  provider: { baseUrl: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY },
});
```

Measured against raw `fetch` to OpenAI, that call is **indistinguishable from
having no SDK at all**:

| comparison | median gap | 95% confidence interval |
|---|--:|---|
| BYO (no trace) − OpenAI direct | −5 ms | −29 ms to +21 ms |

The interval straddles zero. Read it the honest way: **the SDK adds nothing
measurable to a direct provider call.** The local gateway doesn't either, so on
the same machine BYO saves no measurable time. The reason to choose BYO is that
your provider key stays on your own machines.

**Tracing never blocks the response either way.** The SDK reports its own trace
in the background — a queue that drains after `hub.gateway.chat()` has already handed the
answer back, on no fixed timer — so turning tracing on or off on the BYO path
makes no measurable difference to the request:

| comparison | median gap | 95% confidence interval |
|---|--:|---|
| BYO (tracing on) − BYO (no trace) | −15 ms | −41 ms to +15 ms |

That interval crosses zero too: tracing on and tracing off are, statistically,
the same request.

:::tip
Both takeaways here are portable, and neither is the raw millisecond count. The
gateway's code costs tens of milliseconds at most. A hop across the internet costs
hundreds — so anything your application doesn't read back synchronously has no
reason to travel synchronously either.
:::

## Don't forget the tail

Medians tell you the typical case, but users remember the slow one:

| Path | median | p95 | p99 |
|---|--:|--:|--:|
| BYO, tracing on | 621 ms | 783 ms | 832 ms |
| Local gateway | 632 ms | 919 ms | 1012 ms |
| BYO, no trace | 634 ms | 845 ms | 1075 ms |
| OpenAI direct | 639 ms | 753 ms | 891 ms |
| Hosted gateway | 1176 ms | 1376 ms | 1526 ms |

The tail is wider than the median suggests for every path — plan for the p99,
not the median, when a call like this sits on a user-facing route. With only 60
rounds per path, treat these tails as a rough shape rather than a precise claim.

A larger run is in
[full-cycle latency across six LLM-ops platforms](/blog/full-cycle-latency-benchmark).
That benchmark ran 100 rounds four times, on real OpenAI billing, against five
other LLM-ops platforms, and it plots every round. Most of its paths also fetch
a stored prompt before the completion, so its gateway numbers measure a different
request from the one in this post.

## What this means for you

- **The gateway's own code adds no measurable time** — at most 28 ms in this
  run, for provider routing, cost tracking, caching, budgets, and fallback.
- **Skipping the gateway is about where your key lives, not speed** — BYO keeps
  your provider key on your own machines, and saves no measurable time.
- **Tracing costs nothing extra on the BYO path** — it runs on a background
  queue, so leaving it on doesn't change what your user waits on.
- **Most real-world latency is network distance**, which you control by
  deploying close to your callers. The hosted gateway's ~550 ms gap over BYO
  today is geography, not code.

For a walk-through of the BYO path end to end — your own key, your own embeddings,
prompts and traces still working — see
[build a RAG agent without the gateway](https://docs.acruxcore.com/docs/tutorials/build-a-rag-agent-without-the-gateway).
For the other side of the trade, see
[routing your calls through the gateway](https://docs.acruxcore.com/docs/guides/route-calls-through-the-gateway).

:::note
Want to reproduce this? The
[benchmark script, its `results.json` and `summarize.mjs`](https://github.com/AcruxCore/AcruxCore/tree/main/scripts/blogs/llm-gateway-overhead/typescript)
are on GitHub. `summarize.mjs` turns any run's `results.json` into the tables above.
Every path used the same model, key, prompt, and parameters, over pooled
connections, 60 interleaved rounds with a rotating order.
:::
