---
title: "14 OpenRouter alternatives: gateways, resellers and local models (2026)"
description: "Fourteen OpenRouter alternatives compared on fees, bring-your-own-key support, self-hosting and routing: gateways you run with your own keys, hosted resellers, cloud catalogs and local models."
title_meta: "14 Best OpenRouter Alternatives in 2026 (Fees Compared)"
slug: openrouter-alternatives
date: 2026-10-28
authors: [acrux]
tags: [llm-gateway, llmops-comparison]
image: /img/blog/openrouter-alternatives/01-header.webp
keywords: [openrouter alternatives, openrouter alternative, openrouter vs litellm, openrouter pricing comparison, openrouter vs ollama, sites like openrouter, openrouter competitors, self-hosted openrouter alternative, open source openrouter alternative]
last_update:
  date: 2026-10-28
---

![Fourteen OpenRouter alternatives in four columns: Your own keys (AcruxCore (ours), LiteLLM, Portkey, Kong AI Gateway, Helicone), One bill (Vercel AI Gateway, Cloudflare AI Gateway, Requesty, Eden AI, NanoGPT), Cloud catalogs (Amazon Bedrock, Together AI, Hugging Face) and Local models (Ollama)](/img/blog/openrouter-alternatives/01-header.webp)

This post compares fourteen OpenRouter alternatives on fees, bring-your-own-key support,
self-hosting and routing. After it, you can tell whether you need a reseller, a gateway you run
yourself, a cloud catalog or a local runtime.

We build AcruxCore, one of the tools in this post. We do not rank it.

<!-- truncate -->

**The short answer**

The question that decides the choice is who bills you for tokens. OpenRouter resells model
access: you buy credits from OpenRouter and need no provider accounts. A gateway you run
yourself sends calls with your own provider keys, and each provider bills you.

![Who bills you for tokens in each group: a gateway with your own keys means your provider bills you, a hosted reseller bills you from credits, a cloud catalog bills through your cloud account, and local models need no bill](/img/blog/openrouter-alternatives/02-who-bills.webp)

- **If you want a gateway you run with your own keys:** AcruxCore (ours) or LiteLLM.
  AcruxCore's gateway has spend budgets, rate limits and fallbacks, and the same app holds
  prompt versions, traces and evals. AcruxCore is Apache-2.0 and self-hosts for free on
  Postgres and Redis. LiteLLM is a gateway only, with the most routing options. LiteLLM is MIT,
  has 61,735 GitHub stars and balances load across deployments.
- **If you want one bill with no fee on tokens:** Vercel AI Gateway. It charges no markup, with
  or without your own keys, though card processing fees may apply.
- **If you are on AWS:** Amazon Bedrock bills through your AWS account and does not share
  prompts with model providers.
- **If prompts must stay on your own hardware:** Ollama runs open models locally for free.

## OpenRouter competitors at a glance

**Who bills you, and the fee on top of token prices**

| Tool | Group | Who bills you for tokens | Fee on top of token prices | Bring your own keys | Self-host |
|---|---|---|---|---|---|
| **OpenRouter** | Hosted reseller | OpenRouter, from credits | 5.5% on credit purchases (8% on Business) | Yes; 5% fee after $25,000 a month | No |
| AcruxCore (ours) | Gateway, your keys | Your provider | None | Yes; your keys only | Free, Apache-2.0 |
| LiteLLM | Gateway, your keys | Your provider | None | Yes; your keys only | Free, MIT core |
| Portkey | Gateway, your keys | Your provider | None | Yes; your keys only | Free, MIT gateway |
| Kong AI Gateway | Gateway, your keys | Your provider | None | Yes; your keys only | Free, Apache-2.0 core |
| Helicone | Gateway, both | Your provider, or Helicone credits | 0% markup on credits | Yes | Free, Apache-2.0 |
| Vercel AI Gateway | Hosted reseller | Vercel, from credits | None; card fees may apply | Yes, no fee | No |
| NanoGPT | Hosted reseller | NanoGPT, from a balance | None by default; 5% to pin a specific provider | Yes; 5% fee | No |
| Requesty | Hosted reseller | Requesty, from a balance | 5% on top-ups | Yes | No |
| Cloudflare AI Gateway | Hosted reseller | Cloudflare, from credits | 5% on credit purchases | Yes | No |
| Eden AI | Hosted reseller | Eden AI, from credits | 5.5% at checkout | Yes | No |
| Amazon Bedrock | Cloud catalog | AWS | Not applicable | No | No |
| Together AI | Cloud catalog | Together, prepaid | Not applicable | No | No |
| Hugging Face Inference Providers | Cloud catalog | Hugging Face | No markup | Yes, no fee | No |
| Ollama | Local models | Nobody, when local | Not applicable | Not applicable | Free, MIT |

**Bring your own keys (BYOK)** means the tool sends your calls with an API key from your own
provider account. A **reseller** buys model access in bulk and sells it to you from one balance.

**Gateway controls**

| Tool | Fallbacks | Load balancing | Response cache | Spend budget that stops calls | Rate limits |
|---|---|---|---|---|---|
| **OpenRouter** | Yes | Across providers, by price | Yes | Yes, on paid plans | 20 a minute on free models |
| AcruxCore (ours) | Yes | No | Exact match | Yes, per team or key | Per key, requests and tokens |
| LiteLLM | Yes | Yes, six strategies | Exact and semantic | Yes, per key, user or team | Per key and team |
| Portkey | Yes | Yes | Exact; semantic on a paid plan | Enterprise and some Pro | Enterprise and some Pro |
| Kong AI Gateway | Yes | Enterprise | Semantic, Enterprise | Enterprise | Requests only in the free core |
| Helicone | Yes | Across providers, by cost | Exact match | Not stated | By requests or cost |
| Vercel AI Gateway | Yes | Not stated | Provider prompt caching only | Yes | None on paid requests |
| NanoGPT | Yes | Not stated | Provider prompt caching only | Daily cap per key | 25 a second |
| Requesty | Yes | Yes | Provider prompt caching only | Yes | 200 a day on free |
| Cloudflare AI Gateway | Yes | Percentage splits | Exact match, at the edge | Yes | Yes |
| Eden AI | Yes | By price, speed or latency | Yes, on by default | Per key | 10 a second |
| Amazon Bedrock | No | Across AWS Regions | Not stated | Not stated | AWS quotas |
| Together AI | Not documented | Not stated | Not stated | Not stated | Not stated |
| Hugging Face | Yes, with `provider="auto"` | Picks the fastest or cheapest provider | Not stated | Not stated | Not stated |
| Ollama | Not documented | Not applicable | Not applicable | Not applicable | Not applicable |

A **fallback** sends the call to another model or provider when the first one fails. A
**response cache** returns a stored reply for an identical request without calling the
provider. **Provider prompt caching** is different: the provider reuses the start of a long
prompt and charges less for it, but still runs the model.

:::tip[Our product: AcruxCore]

We build AcruxCore, so we do not rank it. AcruxCore is a gateway you run with your own provider
keys, and the same app versions prompts, traces calls and runs evals. AcruxCore is Apache-2.0
and self-hosts for free on Postgres and Redis. It fits a team that has provider keys and wants
spend budgets on its own servers. It does not fit a team that wants one bill and no provider
accounts, because AcruxCore does not sell model access. The details are in
[About AcruxCore](#about-acruxcore).

:::

## Why look for OpenRouter alternatives?

- **OpenRouter charges a fee on every credit purchase.** The fee is 5.5% on Standard, with a
  $0.80 minimum on cards, and 8% on Business. Token prices are the provider's list price.
- **Your own keys cost extra after $25,000 a month.** Past $25,000 of BYOK use a month at list
  prices, OpenRouter charges 5% of each call's normal OpenRouter price. The Free plan has no
  BYOK.
- **Free models have a daily cap.** Free models allow 20 requests a minute and 50 a day. The
  daily cap rises to 1,000 once you have bought $10 of credits. Failed attempts count toward
  the daily cap.
- **OpenRouter is not self-hostable.** Every call goes through OpenRouter's servers. In-region
  routing to the EU is on the Business and Enterprise plans only.

> **Key point:** OpenRouter charges a fee of 5.5% on every credit purchase on Standard, and 8%
> on Business. Past $25,000 of bring-your-own-key use a month, it charges 5% of each call's normal price.

Sources: [OpenRouter pricing](https://openrouter.ai/pricing),
[OpenRouter FAQ](https://openrouter.ai/docs/faq),
[BYOK](https://openrouter.ai/docs/guides/overview/auth/byok),
[limits](https://openrouter.ai/docs/api-reference/limits),
[in-region routing](https://openrouter.ai/docs/guides/features/in-region-routing).

### OpenRouter pricing in 2026

| Plan | Platform fee | Models | BYOK | Workspaces |
|---|---|---|---|---|
| Free | None | 25+ free models, 50 requests a day | No | 5 |
| Standard | 5.5% on credit purchases | 500+ | $25,000 a month free, then 5% | 5 |
| Business | 8% on credit purchases | 500+ | $25,000 a month free, then 5% | 1,000 |
| Enterprise | Fee discounts | 500+ | Custom | Custom |

The table uses the pricing page's counts, which differ from the models API. On 21 October 2026,
the models API listed 468 models from 113 providers, and 17 of those model ids end in `:free`.

OpenRouter does not store prompts or replies unless you opt in. You can require Zero Data
Retention (ZDR) for every request or for one request, and ZDR routing is on every plan.
**Zero Data Retention** means the provider keeps no copy of your prompt or reply.

Sources: [pricing](https://openrouter.ai/pricing),
[models API](https://openrouter.ai/api/v1/models),
[data collection](https://openrouter.ai/docs/guides/privacy/data-collection),
[ZDR](https://openrouter.ai/docs/guides/features/zdr).

## OpenRouter vs LiteLLM

The two tools do different jobs. OpenRouter is a hosted service that resells model access.
LiteLLM is a proxy you run yourself with your own keys.

| | OpenRouter | LiteLLM |
|---|---|---|
| What it is | Hosted reseller | Proxy server and Python SDK you run |
| License | Closed source | MIT; the `enterprise/` folder has a commercial license |
| Who bills you for tokens | OpenRouter, from credits | Each provider, with your keys |
| Fee | 5.5% on credit purchases | None for the open-source proxy |
| Providers | 113, serving 468 models | 100+ |
| Routing | Load balancing across providers by price; model fallbacks; an Auto Router | Six load-balancing strategies, fallbacks, retries, cooldowns |
| Spend budgets | Workspace and key budgets on paid plans | Per key, user and team, in the free proxy |
| Where prompts go | Through OpenRouter; not stored unless you opt in | Through your own server |
| Added latency, as the vendor states it | "minimal latency", with no number | 8 ms at the 95th percentile at 1,000 requests a second, on a mock provider |

> **Key point:** OpenRouter bills you from credits, with a 5.5% fee on credit purchases. LiteLLM
> sends calls with your own keys, each provider bills you, and the open-source proxy adds no fee.

Choose OpenRouter if you want one balance and no provider accounts. Choose LiteLLM if you
already have provider keys and want the proxy on your own servers. LiteLLM needs Postgres for
keys and spend tracking, and Redis once you run more than one instance.

Sources: [LiteLLM README](https://github.com/BerriAI/litellm),
[LiteLLM benchmarks](https://docs.litellm.ai/docs/benchmarks),
[LiteLLM deploy](https://docs.litellm.ai/docs/proxy/deploy),
[OpenRouter latency](https://openrouter.ai/docs/guides/best-practices/latency-and-performance).

## How we picked and ranked

- **The tool gives you one API for models from more than one maker**, or, in the case of
  Ollama, one API for many open models on your own machine.
- **The tool is still sold and documented** on 21 October 2026.
- **Groups follow who bills you for tokens.** Gateways you run with your own keys come first,
  then hosted resellers, then single-cloud catalogs, then local models.
- **Inside the gateway group, more gateway controls in the free version rank higher:** budgets,
  rate limits, load balancing and a cache. A tool in maintenance mode ranks last in its group.
- **Inside the reseller group, a lower fee on tokens ranks higher.** At the same fee, more
  controls for teams rank higher.
- **Every fact comes from the vendor:** the pricing page, the docs, the license file or the
  vendor's own API, read on 21 October 2026. GitHub stars come from the GitHub API on the same
  day. We do not use other comparison lists as sources.
- **AcruxCore is not ranked.** We build it, so it has its own section after the ranked tools.

## Gateways you run with your own keys

These four tools sit between your app and the providers. You add your own provider keys, and
each provider bills you at its own prices. Each tool has a free version you can run on your own
servers. Helicone's hosted gateway can also bill you from Helicone credits. AcruxCore (ours)
also works this way: it uses your own keys and is free to self-host. AcruxCore is not ranked,
because we build it; it is described in [About AcruxCore](#about-acruxcore).

### 1. LiteLLM

LiteLLM vs OpenRouter: LiteLLM is an MIT proxy that calls 100+ providers in the OpenAI format,
with your own keys. Budgets, rate limits and load balancing are free in the open-source proxy.

**Best for:** teams that want a gateway only, with load balancing, on their own servers.

| | LiteLLM | OpenRouter |
|---|---|---|
| License | MIT; `enterprise/` folder commercial | Closed source |
| Self-host | Docker image; Postgres for keys and spend, Redis for more than one instance | No |
| Fee | None for the open-source proxy | 5.5% on credit purchases |
| GitHub stars | 61,735 | Not open source |

**Where LiteLLM differs**

- The router has six strategies: weighted shuffle, rate-limit aware, latency-based,
  least-busy, lowest-cost and custom.
- Budgets and rate limits per key, user and team are free. A key over its budget is refused.
- The cache stores replies in Redis, S3, GCS, memory or disk. A semantic cache works with Redis,
  Valkey or Qdrant.
- Logging callbacks send calls to Langfuse, OpenTelemetry, LangSmith, Datadog and others.

**Limits of LiteLLM**

- SSO for more than five users, audit logs and budgets per tag need the Enterprise license,
  which has no public price.
- LiteLLM has no prompt registry of its own and no eval runner. It connects to other tools,
  such as Langfuse, for prompt management and eval logging.
- With no database, a key's budget is not enforced, and LiteLLM logs only a warning at startup.
- In March 2026, versions 1.82.7 and 1.82.8 on PyPI were malicious. LiteLLM's security post
  says the Docker image on ghcr was not affected.

Sources: [license](https://github.com/BerriAI/litellm/blob/main/LICENSE),
[enterprise](https://docs.litellm.ai/docs/enterprise),
[routing](https://docs.litellm.ai/docs/routing),
[budgets](https://docs.litellm.ai/docs/proxy/users),
[caching](https://docs.litellm.ai/docs/proxy/caching),
[security update](https://docs.litellm.ai/blog/security-update-march-2026).

### 2. Portkey

Portkey vs OpenRouter: Portkey is an MIT gateway you can run with one `npx` command, plus a
hosted platform with logs and prompt templates. Palo Alto Networks completed its acquisition of
Portkey on 29 May 2026.

**Best for:** teams that want a light gateway with fallbacks and load balancing in the free
version.

| | Portkey | OpenRouter |
|---|---|---|
| License | MIT gateway | Closed source |
| Self-host | `npx @portkey-ai/gateway`, Docker or Cloudflare Workers | No |
| Hosted free plan | Developer: 10,000 logs a month, kept 3 days | Free models only |
| Cheapest paid plan | Production: $49 a month, 100,000 logs | Pay as you go, 5.5% fee |
| GitHub stars | 13,244 | Not open source |

**Where Portkey differs**

- Fallbacks, load balancing and conditional routing are on every plan.
- The README lists retries, request timeouts and guardrails in the open-source gateway.
- The hosted plans add logs, traces and versioned prompt templates.

**Limits of Portkey**

- Budgets and rate limits per key are on Enterprise and some Pro plans only.
- The open-source repository's last commit was on 25 May 2026, and its last release was v1.15.2
  in January 2026.
- The docs put semantic caching on Enterprise, and the pricing page puts it on the Production
  plan.

Sources: [license](https://github.com/Portkey-AI/gateway/blob/main/LICENSE),
[pricing](https://portkey.ai/pricing),
[budget limits](https://portkey.ai/docs/product/ai-gateway/virtual-keys/budget-limits),
[caching](https://portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic),
[acquisition](https://www.paloaltonetworks.com/company/press/2026/palo-alto-networks-completes-acquisition-of-portkey-to-secure-ai-agents).

### 3. Kong AI Gateway

Kong vs OpenRouter: Kong is an Apache-2.0 API gateway with AI plugins. It sends LLM calls in the
OpenAI format to 20 providers.

**Best for:** teams that already run Kong for their other APIs.

| | Kong AI Gateway | OpenRouter |
|---|---|---|
| License | Apache-2.0 core; advanced AI plugins need Enterprise | Closed source |
| Self-host | Postgres or no database | No |
| Cheapest hosted plan | Konnect Plus: from $25 a month, plus usage | Pay as you go, 5.5% fee |
| GitHub stars | 44,290 | Not open source |

**Where Kong differs**

- The free core has plugins for a proxy, prompt templates, prompt guards and request and
  response transforms.
- Kong sells metering and billing, so you can charge your own customers for AI use.
- Token use, latency and cost go out through OpenTelemetry and Kong's metrics exporters.

**Limits of Kong**

- Load balancing, the semantic cache and limits on tokens or cost are Enterprise plugins.
- The newest open-source release is 3.9.4, from October 2026. Versions 3.10 to 3.14 appear
  only in Kong's Enterprise docs.
- On Konnect Plus, each model past the fifth costs $100 a month.

Sources: [license](https://github.com/Kong/kong/blob/master/LICENSE),
[AI Gateway](https://developer.konghq.com/ai-gateway/),
[providers](https://developer.konghq.com/ai-gateway/ai-providers/),
[AI Proxy Advanced](https://developer.konghq.com/plugins/ai-proxy-advanced/),
[pricing](https://konghq.com/pricing).

### 4. Helicone

Helicone vs OpenRouter: Helicone is an Apache-2.0 observability platform with a gateway. The
hosted gateway takes your own keys first, then falls back to Helicone credits at 0% markup.

**Best for:** teams that want request logs and cost tracking, with the option of one bill.

| | Helicone | OpenRouter |
|---|---|---|
| License | Apache-2.0 | Closed source |
| Self-host | Web, a proxy worker, Express API, Supabase, ClickHouse, MinIO | No |
| Who bills you for tokens | Your provider, or Helicone credits at 0% markup | OpenRouter, with a 5.5% fee |
| Hosted free plan | Hobby: 10,000 requests a month, kept 7 days | Free models only |
| Cheapest paid plan | Pro: $79 a month | Pay as you go, 5.5% fee |
| GitHub stars | 6,231 | Not open source |

**Where Helicone differs**

- The gateway finds every provider that serves a model and sends the call to the cheapest one.
- A rate-limit header can limit calls by count, by cost or by a custom property.
- Helicone versions prompts and serves them through the gateway.

**Limits of Helicone**

- Mintlify acquired Helicone in March 2026 and said Helicone would run in maintenance mode.
  In October 2026, Helicone's website says the company is no longer part of Mintlify, with no
  other details.
- A self-hosted install runs six services, including ClickHouse.
- The docs describe rate limits by cost, but no separate spend budget that stops calls.

Our comparison: [AcruxCore vs Helicone](/blog/acruxcore-vs-helicone).

Sources: [license](https://github.com/Helicone/helicone/blob/main/LICENSE),
[gateway](https://docs.helicone.ai/gateway/overview),
[provider routing](https://docs.helicone.ai/gateway/provider-routing),
[pricing](https://www.helicone.ai/pricing),
[Mintlify post](https://www.mintlify.com/blog/mintlify-acquires-helicone).

## Hosted resellers: one bill, no provider accounts

These five tools work the way OpenRouter does. You load a balance, and the tool pays the
providers for you. Most also accept your own keys. None of them can be self-hosted.

### 5. Vercel AI Gateway

Vercel AI Gateway vs OpenRouter: Vercel charges no markup and no platform fee on tokens, with
or without your own keys. Your app does not need to run on Vercel.

**Best for:** teams that want one bill with no fee on tokens.

| | Vercel AI Gateway | OpenRouter |
|---|---|---|
| Fee on tokens | None; card processing fees may apply | 5.5% on credit purchases |
| BYOK fee | None | 5% after $25,000 a month |
| Free credit | $5 a month, on some models | Free models only |
| Models | 482 in its models API | 468 in its models API |

**Where Vercel differs**

- The gateway speaks the OpenAI Chat Completions and Responses formats, and Anthropic Messages.
- Fallbacks work across providers and across models.
- Budgets can be set per team, project, key or member.
- Vercel says the gateway does not log prompts or replies.

**Limits of Vercel**

- Purchased credits expire one year after purchase.
- If a call with your own key fails, the gateway retries with Vercel's keys and bills your
  credits.
- Team-wide ZDR costs $0.10 per 1,000 requests. ZDR on a single request is free.

Sources: [pricing](https://vercel.com/docs/ai-gateway/pricing),
[FAQ](https://vercel.com/docs/ai-gateway/faq),
[BYOK](https://vercel.com/docs/ai-gateway/authentication-and-byok/byok),
[ZDR](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr).

### 6. NanoGPT

NanoGPT vs OpenRouter: NanoGPT is a chat app and an API with no fee on tokens by default. It
accepts crypto and needs no account.

**Best for:** individuals who want to pay small amounts, including in crypto, with no account.

| | NanoGPT | OpenRouter |
|---|---|---|
| Fee on tokens | None by default; 5% to pin a specific provider | 5.5% on credit purchases |
| BYOK fee | 5% | 5% after $25,000 a month |
| Subscription | Pro: $12 a month, 60M input tokens a week | None |
| Models | 668 in its models API | 468 in its models API |

**Where NanoGPT differs**

- Deposits start at $0.10 in crypto or $1 by card. No account or email is needed.
- Each key can have a daily cap on requests and on spend.
- NanoGPT also has APIs for images, video, speech, embeddings and web search.

**Limits of NanoGPT**

- The global rate limit is 25 requests a second.
- With your own key, a failed call returns an error by default and does not fall back.

Sources: [pricing](https://nano-gpt.com/pricing),
[BYOK](https://docs.nano-gpt.com/api-reference/miscellaneous/byok.md),
[rate limits](https://docs.nano-gpt.com/api-reference/miscellaneous/rate-limits.md),
[privacy](https://nano-gpt.com/privacy).

### 7. Requesty

Requesty vs OpenRouter: Requesty is a hosted router with an OpenAI-compatible API and a 5% fee
on top-ups, against OpenRouter's 5.5%.

**Best for:** teams that want an OpenRouter-style router with an EU endpoint on every plan.

| | Requesty | OpenRouter |
|---|---|---|
| Fee on tokens | 5% on top-ups | 5.5% on credit purchases |
| Free plan | Free models, 200 requests a day | Free models, 50 requests a day |
| Models | 803 in its models API | 468 in its models API |
| EU endpoint | Every plan | Business and Enterprise |

**Where Requesty differs**

- Routing has fallback policies, load balancing and routing by latency.
- Budgets can be set per team, user and key, with alerts.
- Prompts are stored only when you turn on logging for a key.

**Limits of Requesty**

- BYOK needs the pay-as-you-go plan. The docs do not say whether BYOK calls carry a fee.
- Once you turn on Zero Data Retention for an organization, you cannot turn it off.

Sources: [pricing](https://www.requesty.ai/pricing),
[billing](https://docs.requesty.ai/features/billing),
[BYOK](https://docs.requesty.ai/features/bring-your-own-keys),
[data privacy](https://docs.requesty.ai/features/data-privacy).

### 8. Cloudflare AI Gateway

Cloudflare AI Gateway vs OpenRouter: Cloudflare's gateway adds logs, caching and rate limits to
your calls for free. Its Unified Billing resells model access with a 5% fee on credits.

**Best for:** teams already on Cloudflare that want a response cache at the edge.

| | Cloudflare AI Gateway | OpenRouter |
|---|---|---|
| Fee on tokens | 5% on credit purchases, with Unified Billing | 5.5% on credit purchases |
| BYOK | Yes, in the request or in Secrets Store | Yes |
| Free features | Analytics, caching and rate limiting | Free models only |
| Providers | 24 listed | 113 in its API |

**Where Cloudflare differs**

- The cache stores replies to identical requests at the edge, for 60 seconds up to one month.
- Dynamic routing splits traffic by percentage. A route can fall back to another route when it
  reaches its budget limit or rate limit.
- OpenRouter is one of the 24 listed providers, so Cloudflare can sit in front of OpenRouter.

**Limits of Cloudflare**

- Logs are on by default and include the prompt and the reply. A header turns this off for one
  request.
- The gateway docs describe no ZDR option.
- On gateways created from 24 September 2026, logs are kept 3 days on Free and 7 days on Paid.

Sources: [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/),
[pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/),
[providers](https://developers.cloudflare.com/ai-gateway/usage/providers/),
[caching](https://developers.cloudflare.com/ai-gateway/features/caching/),
[logging](https://developers.cloudflare.com/ai-gateway/observability/logging/).

### 9. Eden AI

Eden AI vs OpenRouter: Eden AI resells LLMs and also APIs for OCR, speech, translation and
document parsing, all with one key and a 5.5% fee.

**Best for:** apps that call LLMs and also need OCR, speech or translation from one vendor.

| | Eden AI | OpenRouter |
|---|---|---|
| Fee on tokens | 5.5% at checkout | 5.5% on credit purchases |
| Models | 1,216 entries in its models API, LLMs and other models | 468 in its models API |
| Rate limit | 10 requests a second by default | 20 a minute on free models |
| Region | EU and US endpoints | EU on Business and Enterprise |

**Where Eden AI differs**

- A response cache for identical requests is on by default, and cache hits are free.
- Eden AI stores no request or reply content by default.
- Routing picks a provider by price, speed or latency, with fallback models.

**Limits of Eden AI**

- The docs do not say which plans include BYOK.
- The pricing page states no free tier.

Sources: [pricing](https://www.edenai.co/pricing),
[plans](https://www.edenai.co/docs/v3/overview/plans-prices.md),
[caching](https://www.edenai.co/docs/v3/general/caching.md),
[data retention](https://www.edenai.co/docs/v3/data-governance/data-retention.md).

## Cloud catalogs: one provider, many models

Each of these three tools serves many models from one account. Bedrock and Together run the
models themselves. Hugging Face routes your call to one of its partner providers.

### 10. Amazon Bedrock

Bedrock vs OpenRouter: Bedrock serves models from 19 providers, Anthropic and OpenAI among them,
billed through your AWS account.

**Best for:** teams that already run on AWS and must keep prompts inside AWS.

| | Amazon Bedrock | OpenRouter |
|---|---|---|
| Who bills you | AWS, per token | OpenRouter, from credits |
| Providers | 19 on the model cards page | 113 in its API |
| OpenAI-compatible endpoint | Yes, Chat Completions | Yes |
| Fallbacks | None; routes across AWS Regions | Across providers and models |

**Where Bedrock differs**

- AWS says prompts and replies are not shared with model providers and are not used for
  training.
- Batch inference costs 50% less than on-demand on some models.
- A global inference profile routes calls to any commercial Region, and AWS says it saves
  about 10%.

**Limits of Bedrock**

- Bedrock does not fall back to another model. AWS tells you to build that into your app.
- Anthropic models need a one-time form with your use case before first use.
- Model ids are Bedrock's own, such as `openai.gpt-oss-120b-1:0`.

Sources: [pricing](https://aws.amazon.com/bedrock/pricing/),
[model cards](https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html),
[Chat Completions](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html),
[cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html),
[FAQ](https://aws.amazon.com/bedrock/faqs/).

### 11. Together AI

Together AI vs OpenRouter: Together runs open-weight models on its own GPUs, with an
OpenAI-compatible API and prepaid billing.

**Best for:** teams that use open-weight models, such as gpt-oss, Llama, Qwen or DeepSeek, and
also want fine-tuning.

| | Together AI | OpenRouter |
|---|---|---|
| Who bills you | Together, prepaid | OpenRouter, from credits |
| Chat models | 22 from 12 organizations | 468 models |
| Example price | gpt-oss-120B: $0.15 in, $0.60 out per 1M tokens | Provider list price |
| Free trial | None | Free models |

**Where Together differs**

- Together also sells dedicated inference and fine-tuning.
- A setting turns off retention of prompts and replies.

**Limits of Together**

- Together serves no Claude or GPT chat models.
- The first purchase is at least $15, and API access stops at a zero balance.
- OpenAI model names such as `gpt-4o` return 404. You use Together's own model ids.

Sources: [pricing](https://www.together.ai/pricing),
[billing](https://docs.together.ai/docs/billing),
[serverless models](https://docs.together.ai/docs/serverless-models),
[OpenAI compatibility](https://docs.together.ai/docs/openai-api-compatibility).

### 12. Hugging Face Inference Providers

Hugging Face vs OpenRouter: Hugging Face routes your call to one of 18 partner providers, with
one token and one bill and no markup.

**Best for:** teams that use open-weight models from the Hugging Face Hub.

| | Hugging Face | OpenRouter |
|---|---|---|
| Fee on tokens | None; "the same rates as the provider" | 5.5% on credit purchases |
| Monthly credit | PRO: $2; Free: none | Free models only |
| Partner providers | 18 | 113 in its API |
| BYOK | Yes; the provider bills you | Yes |

**Where Hugging Face differs**

- A suffix on the model name picks the provider: `:fastest`, `:cheapest`, or a provider name
  such as `:groq`.
- With `provider="auto"`, a call moves to another provider when Hugging Face marks the first
  provider unavailable.
- Hugging Face says it does not store request or reply bodies when it routes a call.

**Limits of Hugging Face**

- The OpenAI-compatible endpoint covers chat only. Images, embeddings and speech need the
  Hugging Face client.
- The models are mostly open-weight.

Sources: [overview](https://huggingface.co/docs/inference-providers/index),
[pricing](https://huggingface.co/docs/inference-providers/pricing),
[security](https://huggingface.co/docs/inference-providers/security).

## Local models

### 13. Ollama

Ollama vs OpenRouter: Ollama runs open models on your own machine for free, behind an
OpenAI-compatible API on `localhost`.

**Best for:** developers who want prompts to stay on their own hardware, or want to work
offline.

| | Ollama | OpenRouter |
|---|---|---|
| License | MIT | Closed source |
| Cost | Free on your own hardware; Ollama Cloud Pro: $20 a month | 5.5% fee on credits |
| Models | Open models such as Llama, Qwen, Gemma, DeepSeek, Mistral and gpt-oss | 468 models, closed ones included |
| GitHub stars | 184,169 | Not open source |

**Where Ollama differs**

- The local API at `http://localhost:11434/v1/` accepts the OpenAI client.
- Ollama runs on NVIDIA, AMD and Apple GPUs, and falls back to the CPU.
- Ollama Cloud says it never logs prompts or replies and never trains on them.

**Limits of Ollama**

- The OpenAI-compatible API does not support `tool_choice` or image URLs.
- Ollama serves no closed models, such as Claude or GPT-5.

Sources: [license](https://github.com/ollama/ollama/blob/main/LICENSE),
[OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility),
[GPU support](https://docs.ollama.com/gpu),
[pricing](https://ollama.com/pricing).

## About AcruxCore

AcruxCore is our own product, so it has no rank in this list.

AcruxCore vs OpenRouter: AcruxCore is an Apache-2.0 platform with a gateway, prompt versions,
tracing and evals. It does not sell model access, so you bring your own provider keys.

**Best for:** teams that want a gateway with spend budgets on their own servers, and also want
prompt versions, traces and evals in the same app.

| | AcruxCore | OpenRouter |
|---|---|---|
| License | Apache-2.0, with no enterprise folder | Closed source |
| Who bills you for tokens | Your provider, at its own prices | OpenRouter, with a 5.5% fee on credits |
| Self-host | Postgres, Redis, API, worker, web | No |
| Providers | OpenAI, Anthropic and Gemini, plus any OpenAI-compatible base URL | 468 models from 113 providers |
| Cheapest paid plan | None; the hosted plan is free | Pay as you go, 5.5% fee |

**Where AcruxCore differs**

- A spend budget for the team or for one key refuses a call with a 402 error before the call
  reaches the provider. Budgets run per day, week, month or in total.
- Each key can have its own limit on requests and tokens per minute.
- Each model can have an ordered list of fallback models. The gateway retries a 429, a 5xx or a
  network error with backoff, then moves to the next model.
- An exact-match cache can be turned on per key. In our caching measurement, a cache hit took
  9 ms at the median and a miss took 902 ms.
- Every gateway call writes a trace span with tokens, cost and latency. The same app versions
  prompts, runs experiments on datasets and scores live traffic with online rules.
- In our July measurement, a local AcruxCore gateway added 42 ms at the median over a direct
  OpenAI call. In our August benchmark of six platforms, the gateway added tens of
  milliseconds, a gap too small to pin to an exact number.
- AcruxCore can send calls to OpenRouter as one of its providers, through an OpenAI-compatible
  connection. The [gateway guide](https://docs.acruxcore.com/docs/guides/route-calls-through-the-gateway) uses OpenRouter
  as its example.

**Limits of AcruxCore**

- If you want one bill and no provider accounts, a hosted reseller fits better. AcruxCore does
  not sell model access.
- If you need load balancing across several deployments of one model, LiteLLM has it.
  AcruxCore maps each model name to one provider connection.
- AcruxCore counts rate limits inside each API process. Several API instances do not share one
  count.
- The built-in price list covers a few models. To track cost for other models, OpenRouter's
  included, you enter their prices yourself.
- AcruxCore has no semantic cache.
- The repository went public in August 2026 and has 11 GitHub stars.

Our measurements: [gateway overhead](/blog/llm-gateway-overhead),
[full-cycle latency across six platforms](/blog/full-cycle-latency-benchmark),
[exact-match caching](/blog/exact-match-gateway-caching). The setup guides start at
[Set spend limits with gateway budgets and rate limits](https://docs.acruxcore.com/docs/guides/set-spend-limits-with-gateway-budgets-and-rate-limits).

Sources: [license](https://github.com/AcruxCore/AcruxCore/blob/main/LICENSE),
[compose file](https://github.com/AcruxCore/AcruxCore/blob/main/docker-compose.local.yml),
[pricing](https://acruxcore.com/pricing).

## Which OpenRouter alternative should you pick?

Start at the top and stop at the first question you answer yes to.

![Decision flow with five questions: prompts must stay on your hardware leads to Ollama; one bill and no provider accounts leads to Vercel AI Gateway; prompts, traces and evals too leads to AcruxCore; load balancing across deployments leads to LiteLLM; already on AWS leads to Amazon Bedrock; otherwise LiteLLM](/img/blog/openrouter-alternatives/03-decision.webp)

### If prompts must not leave your machine

- **Ollama** runs open models locally for free.

### Best self-hosted OpenRouter alternative

- **AcruxCore** (ours) or **LiteLLM**. AcruxCore runs the gateway plus prompt versions, traces
  and evals, on Postgres and Redis. LiteLLM is a gateway only, with load balancing across
  deployments.

### Best OpenRouter alternative for one bill

- **Vercel AI Gateway** for teams: no fee on tokens, with or without your own keys.
- **NanoGPT** for individuals who pay small amounts, in crypto or by card, with no account.

### If you want one provider's catalog

- **Amazon Bedrock** on AWS, with Claude and OpenAI models.
- **Hugging Face Inference Providers** for open-weight models with no markup.

## FAQ

### Is OpenRouter free?

OpenRouter has a Free plan with free models only, at 20 requests a minute and 50 a day. Paid
models cost the provider's list price, plus a 5.5% fee when you buy credits.
([pricing](https://openrouter.ai/pricing))

### How much does OpenRouter charge?

OpenRouter charges the provider's list price for tokens. It adds a fee of 5.5% when you buy
credits on Standard, and 8% on Business. BYOK calls are free up to $25,000 of list-price use a
month, then cost 5%.
([pricing](https://openrouter.ai/pricing))

### Can you self-host OpenRouter?

OpenRouter publishes no self-hosted version. Its GitHub organization holds SDKs and
integrations, not the gateway. AcruxCore (ours), Kong, LiteLLM and Portkey are gateways you can
run on your own servers.
([OpenRouterTeam on GitHub](https://github.com/OpenRouterTeam))

### Does OpenRouter store my prompts?

Not by default. OpenRouter stores prompts only if you opt in, and it always stores metadata
such as token counts and latency.
([data collection](https://openrouter.ai/docs/guides/privacy/data-collection))

### OpenRouter vs Ollama: what is the difference?

OpenRouter is a hosted service for hundreds of models, closed ones included, and charges per
token. Ollama runs open models on your own machine, for free and offline. Both have an
OpenAI-compatible API, so the same client code works with either.

### OpenRouter vs Requesty?

Both resell model access. Requesty charges 5% on top-ups and OpenRouter 5.5% on credit
purchases. Requesty's free plan allows 200 requests a day, and OpenRouter's allows 50.
([Requesty pricing](https://www.requesty.ai/pricing))

### OpenRouter vs Together AI?

OpenRouter routes calls to many providers. Together runs open-weight models on its own GPUs and
serves no Claude or GPT chat models. ([Together models](https://docs.together.ai/docs/serverless-models))

### OpenRouter vs Amazon Bedrock?

Bedrock bills through your AWS account and keeps prompts inside AWS. It routes across AWS
Regions but does not fall back to another model, while OpenRouter falls back across providers
and models. ([cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html))

### OpenRouter vs Hugging Face Inference Providers?

Hugging Face passes provider prices through with no markup, and OpenRouter charges 5.5% on
credits. Hugging Face routes to 18 partners, mostly for open-weight models.
([pricing](https://huggingface.co/docs/inference-providers/pricing))

### OpenRouter vs NanoGPT?

NanoGPT charges no fee on tokens by default and takes crypto with no account. OpenRouter charges
5.5% on credit purchases. ([NanoGPT pricing](https://nano-gpt.com/pricing))

### OpenRouter vs Portkey?

Portkey is a gateway you run with your own keys, and OpenRouter resells model access. Portkey's
budgets and rate limits per key need the Enterprise plan or some Pro plans.
([budget limits](https://portkey.ai/docs/product/ai-gateway/virtual-keys/budget-limits))

## Related posts

- [How much overhead does an LLM gateway add?](/blog/llm-gateway-overhead): the AcruxCore
  gateway against a direct OpenAI call, over 60 rounds.
- [Full-cycle latency across six LLM-ops platforms](/blog/full-cycle-latency-benchmark): prompt
  fetch plus completion on six platforms, timed against real OpenAI over four runs.
- [Exact-match gateway caching](/blog/exact-match-gateway-caching): latency and spend with the
  cache on.
- [One gateway, three providers](/blog/one-gateway-three-providers): the request shape for
  OpenAI, Anthropic and Gemini through one gateway.
- [AcruxCore vs Helicone](/blog/acruxcore-vs-helicone): one prompt rebuilt on each, and 300
  benchmark rounds through both gateways.
