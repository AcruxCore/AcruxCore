---
title: "How much overhead does an LLM gateway add?"
description: We benchmarked five ways to reach the same OpenAI model — through our gateway, around it with your own key, and raw. The gateway's software costs about 42 ms; almost everything else is network distance.
slug: llm-gateway-overhead
authors: [acrux]
tags: [gateway, performance, llm-ops, byok]
image: /img/social-card.png
keywords: [llm gateway latency, ai gateway overhead, openai proxy latency, byok latency, acrux core gateway, llm ops performance]
---

Putting a gateway in front of your model providers buys you a lot: one endpoint
for every provider, cost accounting, caching, virtual keys, and budgets. But it
raises an obvious worry — **am I paying for that with latency?** Every request now
takes an extra hop, and for a user-facing app, milliseconds matter.

So we measured five ways to reach the same model — through our gateway, around
it with your own key, and raw — to see exactly where the milliseconds go.

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
2. **BYO, tracing off** — the SDK's `chat()` with a `provider` config, which posts
   to OpenAI directly and skips our gateway, with auto-tracing switched off.
3. **BYO, tracing on** — the same call with the SDK's *default* tracing, which
   reports a trace to Acrux Core after the model answers.
4. **Local gateway** — the same call through an Acrux Core gateway running on the
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
<svg viewBox="0 0 720 250" role="img" aria-label="Median latency by path, 31 July 2026: BYO no trace 753 ms, OpenAI direct 757 ms, BYO tracing on 766 ms, Local gateway 825 ms, Hosted gateway 1320 ms" style="max-width:100%;height:auto;font-family:system-ui,sans-serif;font-size:14px">
  <line x1="180" y1="18" x2="180" y2="222" stroke="currentColor" stroke-opacity="0.25"/>
  <text x="170" y="42" text-anchor="end" fill="currentColor">BYO, no trace</text>
  <rect x="180" y="26" width="248" height="26" rx="4" fill="#10a37f"/>
  <text x="438" y="44" fill="currentColor" font-weight="700">753 ms</text>
  <text x="170" y="86" text-anchor="end" fill="currentColor">OpenAI direct</text>
  <rect x="180" y="70" width="249" height="26" rx="4" fill="#10a37f"/>
  <text x="439" y="88" fill="currentColor" font-weight="700">757 ms</text>
  <text x="170" y="130" text-anchor="end" fill="currentColor">BYO, tracing on</text>
  <rect x="180" y="114" width="252" height="26" rx="4" fill="#10a37f"/>
  <text x="442" y="132" fill="currentColor" font-weight="700">766 ms</text>
  <text x="170" y="174" text-anchor="end" fill="currentColor">Local gateway</text>
  <rect x="180" y="158" width="271" height="26" rx="4" fill="#6366f1"/>
  <text x="461" y="176" fill="currentColor" font-weight="700">825 ms</text>
  <text x="170" y="218" text-anchor="end" fill="currentColor">Hosted gateway</text>
  <rect x="180" y="202" width="434" height="26" rx="4" fill="#6366f1"/>
  <text x="624" y="220" fill="currentColor" font-weight="700">1320 ms</text>
  <text x="180" y="242" fill="currentColor" fill-opacity="0.6" font-size="12px">0</text>
  <text x="509" y="242" text-anchor="middle" fill="currentColor" fill-opacity="0.6" font-size="12px">1000 ms</text>
</svg>
<figcaption><em>Median of 60 interleaved rounds, 31 July 2026. All three green bars are the same request in every way that matters.</em></figcaption>
</figure>

The three green bars cluster together around 750–770 ms — OpenAI direct, and both
BYO variants, tracing on or off. The two gateway paths sit further out, and that
gap is what the rest of this post is about.

## The gateway's software costs 42 ms

Start with the clean comparison — OpenAI direct versus the same call through a
gateway on the same machine. Same machine means the gateway's call to OpenAI
travels the *identical* network path as the direct baseline, so the gap between
them is purely the gateway's own code.

Because the paths run in the same round, we can subtract them **per round**, which
cancels any blip they shared:

| comparison | median gap | 95% confidence interval |
|---|--:|---|
| Local gateway − OpenAI direct | **+42 ms** | +17 ms to +81 ms |

That's it: **~40 milliseconds** for routing, resolving your model name, applying
your key, recording the call, and accounting the cost. On a request that already
takes ~750 ms of model time, the gateway is roughly **5%** of what you were
already going to wait.

## Skipping the gateway saves that, and nothing else

Hand the SDK a `provider` config and it posts to OpenAI directly — your provider
key never reaches our servers, and there is no hop:

```ts
const result = await hub.chat({
  model: 'gpt-4o-mini',
  messages,
  provider: { baseUrl: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY },
});
```

Measured against raw `fetch` to OpenAI, that call is **indistinguishable from
having no SDK at all**:

| comparison | median gap | 95% confidence interval |
|---|--:|---|
| BYO (no trace) − OpenAI direct | −8.5 ms | −41.6 ms to +14.2 ms |

The interval straddles zero. Read it the honest way: **the SDK adds nothing
measurable to a direct provider call.** The saving over the gateway is real but
small — you get back the ~40 ms you were paying for routing and accounting, and
that's the whole prize.

**Tracing never blocks the response either way.** The SDK reports its own trace
in the background — a queue that drains after `chat()` has already handed the
answer back, on no fixed timer — so turning tracing on or off on the BYO path
makes no measurable difference to the request:

| comparison | median gap | 95% confidence interval |
|---|--:|---|
| BYO (tracing on) − BYO (no trace) | +25 ms | −29 ms to +77 ms |

That interval crosses zero too: tracing on and tracing off are, statistically,
the same request.

:::tip
Both takeaways here are portable, and neither is the raw millisecond count. The
gateway's code costs tens of milliseconds. A hop across the internet costs
hundreds — so anything your application doesn't read back synchronously has no
reason to travel synchronously either.
:::

## Don't forget the tail

Medians tell you the typical case, but users remember the slow one:

| Path | median | p95 | p99 |
|---|--:|--:|--:|
| BYO, no trace | 753 ms | 996 ms | 1468 ms |
| OpenAI direct | 757 ms | 1137 ms | 2812 ms |
| BYO, tracing on | 766 ms | 1409 ms | 2423 ms |
| Local gateway | 825 ms | 1159 ms | 4237 ms |
| Hosted gateway | 1320 ms | 1458 ms | 2001 ms |

The tail is wider than the median suggests for every path — plan for the p99,
not the median, when a call like this sits on a user-facing route. With only 60
rounds per path, treat these tails as a rough shape rather than a precise claim;
a larger run is on our list.

## What this means for you

- **The gateway's software cost is small** — about 40 ms, a few percent of a
  typical model call, in exchange for provider routing, cost tracking, caching,
  budgets, and fallback.
- **Skipping the gateway saves exactly that** — worth having if you want your
  provider key to stay on your own machines, but on its own it was never a big
  performance win.
- **Tracing costs nothing extra on the BYO path** — it runs on a background
  queue, so leaving it on doesn't change what your user waits on.
- **Most real-world latency is network distance**, which you control by
  deploying close to your callers. The hosted gateway's ~550 ms gap over BYO
  today is geography, not code.

For a walk-through of the BYO path end to end — your own key, your own embeddings,
prompts and traces still working — see
[build a RAG agent without the gateway](/docs/tutorials/build-a-rag-agent-without-the-gateway).
For the other side of the trade, see
[routing your calls through the gateway](/docs/guides/route-calls-through-the-gateway).

:::note
Want to reproduce this? Every path used the same model, key, prompt, and
parameters shown above, over pooled connections, 60 interleaved rounds with a
rotating order — the same shape of harness works against any gateway and
provider.
:::
