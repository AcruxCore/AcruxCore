---
title: "15 LiteLLM alternatives: self-hosted gateways, hosted gateways and libraries (2026)"
description: "Fifteen LiteLLM alternatives and competitors compared on license, self-hosting, budgets, rate limits, load balancing and price, plus what happened in the March 2026 PyPI incident."
title_meta: "15 Best LiteLLM Alternatives and Competitors (2026)"
slug: litellm-alternatives
date: 2026-11-03
authors: [acrux]
tags: [llm-gateway, llmops-comparison]
image: /img/blog/litellm-alternatives/01-header.webp
keywords: [litellm alternatives, litellm alternative, litellm competitors, litellm vs portkey, langchain vs litellm, litellm vs truefoundry, litellm hack, litellm poisoning, litellm supply chain attack, self-hosted litellm alternative, open source litellm alternative]
last_update:
  date: 2026-11-03
---

![Fifteen LiteLLM alternatives in a colour-coded grid, each with what it is best for. Self-hosted open source: AcruxCore (ours), MLflow AI Gateway, Bifrost, Apache APISIX, Agent Router, Portkey, Kong AI Gateway, Helicone. Hosted: Cloudflare AI Gateway, Vercel AI Gateway, TrueFoundry, OpenRouter. Library: any-llm, LangChain, Vercel AI SDK](/img/blog/litellm-alternatives/01-header.webp)

This post compares fifteen LiteLLM alternatives on license, self-hosting, gateway controls and
price. It sorts them into gateways you run yourself, hosted gateways and libraries, so you can
tell which kind of tool replaces the part of LiteLLM you use.

We build AcruxCore, one of the tools in this post. We do not rank it.

<!-- truncate -->

**The short answer**

LiteLLM is two things: a proxy server you run, and a Python library you import. Most
alternatives replace only one of the two, so first decide which one you use.

- **If you want the gateway plus prompts, traces and evals in one app:** AcruxCore (ours) or
  MLflow, both Apache-2.0 and free to self-host. AcruxCore's gateway has spend budgets, rate
  limits and fallbacks, and AcruxCore runs on Postgres and Redis.
- **If you want a gateway only, with the most free controls:** Bifrost. It is an Apache-2.0
  Go server with budgets, rate limits, load balancing, a semantic cache and an MCP gateway.
- **If you already run MLflow:** the MLflow AI Gateway runs inside the MLflow server, with
  fallbacks and USD budgets.
- **If you do not want to run a server:** Cloudflare AI Gateway. Its core features are free,
  and it adds no markup on tokens.
- **If you only use `litellm.completion()` in Python:** any-llm, from Mozilla.ai. It wraps
  each provider's official SDK where one exists, and moving over changes the import and the model strings.

## LiteLLM competitors at a glance

**License, self-hosting and price**

| Tool | Group | License | Self-host needs | Price | GitHub stars |
|---|---|---|---|---|---|
| **LiteLLM** | Server and library | MIT; `enterprise/` folder commercial | Postgres; Redis for more than one instance | Free; Enterprise has no public price | 61,748 |
| AcruxCore (ours) | Self-hosted and hosted | Apache-2.0, no enterprise folder | Postgres, Redis, API, worker, web | Free; the hosted plan is free | 11 |
| MLflow AI Gateway | Self-hosted | Apache-2.0 | The MLflow server and a SQL database | Free | 28,480 |
| Bifrost | Self-hosted | Apache-2.0; Enterprise build licensed separately | One binary; SQLite by default, or Postgres | Free; Enterprise has no public price | 9,001 |
| Apache APISIX | Self-hosted | Apache-2.0 | The APISIX server and etcd; Redis for the AI cache | Free | 17,248 |
| Agent Router (formerly Envoy AI Gateway) | Self-hosted | Apache-2.0 | Envoy; Redis for token limits; Kubernetes optional | Free | 2,258 |
| Portkey | Self-hosted and hosted | MIT gateway | `npx`, Docker or Cloudflare Workers | Free; hosted Production $49 a month | 13,243 |
| Kong AI Gateway | Self-hosted and hosted | Apache-2.0 core; advanced AI plugins need Enterprise | Postgres, or no database | Free core; Konnect Plus from $25 a month plus usage | 44,288 |
| Helicone | Self-hosted and hosted | Apache-2.0 | Five services in one container, including ClickHouse | Free; hosted Pro $79 a month | 6,231 |
| Cloudflare AI Gateway | Hosted | Closed source | Not self-hostable | Core features free; 5% fee on billing credits | Not open source |
| Vercel AI Gateway | Hosted | Closed source | Not self-hostable | No markup on tokens | Not open source |
| TrueFoundry | Hosted, or in your cloud on Enterprise | Closed source | Enterprise only | Developer free; Pro $25 per user a month | Not open source |
| OpenRouter | Hosted reseller | Closed source | Not self-hostable | 5.5% fee on credit purchases | Not open source |
| any-llm | Python library | Apache-2.0 | Nothing to run | Free | 2,228 |
| LangChain | Python and JS library | MIT | Nothing to run | Free | 148,213 |
| Vercel AI SDK | TypeScript library | Apache-2.0 | Nothing to run | Free | 27,435 |

Stars come from the GitHub API on 22 October 2026. A **reseller** buys model access and bills
you from one balance. The self-hosted gateways send calls with your own provider keys, and each
provider bills you. Cloudflare, Vercel and Helicone can work either way.

**Gateway controls in each tool's free version**

| Tool | Fallbacks | Load balancing | Response cache | Spend budget that stops calls | Rate limits | MCP gateway |
|---|---|---|---|---|---|---|
| **LiteLLM** | Yes | Yes: five strategies plus custom | Yes: exact and semantic | Yes: per key, user and team | Yes: per key and team | Yes |
| AcruxCore (ours) | Yes | No | Yes: exact match | Yes: per team or key | Yes: per gateway key, requests and tokens | No |
| MLflow AI Gateway | Yes | Yes: weighted traffic split | Not documented | Yes: global, workspace, endpoint or user, in USD | No | No |
| Bifrost | Yes | Yes: weighted | Yes: exact and semantic | Yes: per virtual key, team and customer | Yes: requests and tokens | Yes |
| Apache APISIX | Yes | Yes | Yes: exact and semantic | Not documented | Yes: tokens | Partial: turns an OpenAPI spec into MCP tools |
| Agent Router | Yes | Yes | No | Partial: a token quota per backend | Yes: tokens | Yes |
| Portkey | Yes | Yes | Yes: exact match | No: Enterprise plan | No: Enterprise plan | No: not in the open-source gateway |
| Kong AI Gateway | No: Enterprise | No: Enterprise | No: semantic cache on Enterprise | No: Enterprise | Partial: requests only | No: Enterprise |
| Helicone | Yes | Yes: across providers, by cost | Yes: exact match | Not documented | Yes: by count or cost | Not documented |
| Cloudflare AI Gateway | Yes | Yes: percentage splits | Yes: exact match | Yes: eventually consistent | Yes | Not documented |
| Vercel AI Gateway | Yes | Not stated | No: provider prompt caching only | Partial: a soft cap | No: set by Vercel only | Not documented |
| TrueFoundry | Yes | Yes: weighted and latency-based | Yes: exact and semantic | Yes | Yes: per user, team, model or metadata | Yes |
| OpenRouter | Yes | Yes: across providers, by price, speed and uptime | Yes: exact match, pay-as-you-go plan | Yes: pay-as-you-go plan | Not documented | No |

A **fallback** sends the call to another model when the first one fails. **Load balancing**
spreads calls for one model across several deployments or keys. A **response cache** returns a
stored reply for an identical request without calling the provider. **Provider prompt caching**
is different: the provider reuses the start of a long prompt and charges less, but still runs
the model.

:::tip[Our product: AcruxCore]

We build AcruxCore, so we do not rank it. AcruxCore has a gateway with spend budgets, rate limits
and fallbacks, like LiteLLM. It also versions prompts, traces every call and runs evals. LiteLLM's
own prompt manager is still in beta, and LiteLLM has no eval runner of its own. AcruxCore is Apache-2.0 and self-hosts for free on Postgres and
Redis. It fits a team that wants to replace LiteLLM and the tools around it with one app on its
own servers. It does not fit a team that needs adapters for many providers, load balancing across
several deployments of one model, or a Python library with no server. The details are in
[About AcruxCore](#about-acruxcore).

:::

## Why look for LiteLLM alternatives?

- **Two LiteLLM releases on PyPI were malicious.** On 24 March 2026, versions 1.82.7 and 1.82.8
  carried a credential stealer. LiteLLM's advisory says the official proxy Docker image was not
  affected. The full account is in the FAQ below.
- **Admin features need the Enterprise license.** SSO is free for up to five users. Audit logs,
  role-based access, key rotation, secret managers and budgets per tag need Enterprise, which
  has no public price.
- **LiteLLM is mainly a gateway.** Its prompt manager is a beta feature in the admin UI. It
  has no eval runner of its own: its `/evals` endpoint passes calls through to OpenAI's Evals
  API. Its admin UI logs each request's spend and tokens, and full traces go out through
  callbacks to Langfuse, OpenTelemetry, Datadog and others.
- **Running it in production takes several parts.** LiteLLM needs Postgres for keys and spend,
  and Redis once you run more than one instance. Its production docs give each pod 1 vCPU and
  4 GiB, and call 4 GiB "a floor".
- **Spend tracking can load the database.** LiteLLM's docs say that at 1,000 requests a second,
  or 10 instances, spend tracking can become a database bottleneck.

> **Key point:** On 24 March 2026, LiteLLM versions 1.82.7 and 1.82.8 on PyPI carried a credential
> stealer. LiteLLM's advisory says the official proxy Docker image was not affected.

![Five reasons teams look past LiteLLM: malicious PyPI releases in March 2026, admin features such as audit logs and roles on Enterprise, a gateway only with no eval runner, Postgres and Redis to run in production, and spend tracking load at high traffic](/img/blog/litellm-alternatives/02-why.webp)

Sources: [security update](https://docs.litellm.ai/blog/security-update-march-2026),
[enterprise](https://docs.litellm.ai/docs/enterprise),
[prompt management](https://docs.litellm.ai/docs/proxy/litellm_prompt_management),
[evals](https://docs.litellm.ai/docs/evals_api),
[production](https://docs.litellm.ai/docs/proxy/prod).

### LiteLLM pricing and license in 2026

| | Open source | Enterprise |
|---|---|---|
| License | MIT, for everything outside `enterprise/` | BerriAI Enterprise license, free for development and testing only |
| Price | Free | No public price; a 30-day trial |
| Keys, teams, budgets, rate limits | Yes | Yes |
| Load balancing, fallbacks, cache | Yes | Yes |
| SSO | Up to five users | Any number of users |
| Audit logs, role-based access, key rotation | No | Yes |
| Budgets per tag, alerts on a soft budget | No | Yes |
| Guardrails per key or team | No | Yes |

> **Key point:** LiteLLM's open-source version has keys, budgets, rate limits, load balancing and
> fallbacks. Audit logs, role-based access and key rotation need Enterprise, which has no public
> price.

On 22 October 2026, the repository had 61,748 GitHub stars, and its newest release was v1.106.2,
from 21 October 2026.
The README says LiteLLM calls 100+ providers, and the website says 140+.

Sources: [license](https://github.com/BerriAI/litellm/blob/main/LICENSE),
[enterprise license](https://github.com/BerriAI/litellm/blob/main/enterprise/LICENSE.md),
[website](https://www.litellm.ai/), [README](https://github.com/BerriAI/litellm).

## How we picked and ranked

- **The tool replaces LiteLLM's proxy or LiteLLM's library.** It gives you one API for models
  from more than one provider.
- **The tool is maintained.** Each one had a release or a commit in 2026, and none is archived.
- **Groups follow what you run.** Gateways you run yourself come first, then hosted gateways,
  then libraries you import.
- **Inside the self-hosted group, a tool that also versions prompts, traces calls and runs evals,
  all three, ranks first.** After that, more gateway controls in the free version rank higher:
  budgets, rate limits, load balancing and a cache. A tool whose open-source code has stopped
  moving, or that is in maintenance mode, ranks lower in its group.
- **Inside the hosted group, no fee on tokens ranks higher, then more controls you set
  yourself,** such as rate limits and a response cache. TrueFoundry charges per user, and
  OpenRouter takes a fee on credits, so those two come last.
- **AcruxCore is not ranked.** We build it, so it has its own section after the ranked tools.
- **Every fact comes from the vendor:** the pricing page, the docs, the license file or the
  GitHub API, read on 22 October 2026. We do not use other comparison lists as sources.

## Self-hosted open-source LiteLLM alternatives

These seven tools have a version you run on your own servers, and each provider bills you at
its own prices. The first one, the MLflow AI Gateway, also versions prompts, traces calls and
runs evals in the same app. AcruxCore (ours) does all of that too, on your own servers. AcruxCore
is not ranked, because we build it, and it is described in [About AcruxCore](#about-acruxcore).

![Three kinds of LiteLLM alternative. A gateway you run: your app calls your server, which calls the providers. A hosted gateway: your app calls the vendor's servers, which call the providers. A library: your app and the library call the providers, with no server at all](/img/blog/litellm-alternatives/03-three-kinds.webp)

### 1. MLflow AI Gateway

MLflow AI Gateway vs LiteLLM: the gateway runs inside the MLflow server, next to MLflow's prompt
registry, tracing and evals. It is Apache-2.0, from the Linux Foundation.

**Best for:** teams that already run MLflow and want their LLM calls in the same server.

| | MLflow AI Gateway | LiteLLM |
|---|---|---|
| License | Apache-2.0 | MIT; `enterprise/` folder commercial |
| Self-host | `mlflow server` with a SQL database | Postgres; Redis for more than one instance |
| Providers | About 14 built in; more through an optional LiteLLM install | 100+ |
| Rate limits | None | Per key and team |

**Where MLflow differs**

- MLflow 3.9.0, released in January 2026, rebuilt the gateway inside the tracking server.
- Each endpoint can have fallbacks and a weighted split of traffic across models.
- A USD budget, global or per workspace, endpoint (since 3.15) or user (since 3.16), returns a
  429 once it is exceeded.
- Guardrails run an LLM judge on requests or replies.

**Limits of MLflow**

- The gateway in the MLflow server has no rate limits. Issue
  [#23345](https://github.com/mlflow/mlflow/issues/23345), which asks for them, is still open.
- Each worker counts its own spend unless you set up the Redis tracker, so several workers
  together can go over one budget.
- For providers outside the built-in list, MLflow uses LiteLLM itself.

Our comparison: [AcruxCore vs MLflow](/blog/acruxcore-vs-mlflow).

Sources: [AI Gateway](https://mlflow.org/docs/latest/genai/governance/ai-gateway/),
[providers](https://github.com/mlflow/mlflow/blob/master/docs/docs/genai/governance/ai-gateway/endpoints/model-providers.mdx),
[routing and fallbacks](https://mlflow.org/docs/latest/genai/governance/ai-gateway/traffic-routing-fallbacks/),
[budgets](https://mlflow.org/docs/latest/genai/governance/ai-gateway/budget-alerts-limits/),
[v3.9.0](https://github.com/mlflow/mlflow/releases/tag/v3.9.0),
[v3.15.0](https://github.com/mlflow/mlflow/releases/tag/v3.15.0),
[v3.16.0](https://github.com/mlflow/mlflow/releases/tag/v3.16.0).

### 2. Bifrost

Bifrost vs LiteLLM: Bifrost, from Maxim AI, is an Apache-2.0 gateway written in Go. Budgets,
rate limits, load balancing and a semantic cache are all in the free version.

**Best for:** teams that want a gateway only, with LiteLLM's controls and lower overhead.

| | Bifrost | LiteLLM |
|---|---|---|
| License | Apache-2.0; Enterprise build licensed separately | MIT; `enterprise/` folder commercial |
| Self-host | `npx`, Docker or Helm; SQLite by default, or Postgres | Postgres; Redis for more than one instance |
| Built-in UI | Yes | Yes |
| Library mode | Go SDK only | Python SDK |

**Where Bifrost differs**

- Virtual keys carry budgets at several levels: the key, the team and the customer. A call
  goes through only when every level has budget left.
- The cache has an exact-match mode that needs no embeddings, and a semantic mode that adds
  them. Both modes store entries in a vector store, such as Redis.
- The free version includes an MCP gateway and a prompt repository.
- Bifrost's own benchmark reports 11 µs of added latency at 5,000 requests a second, on a
  t3.xlarge against a mocked OpenAI endpoint.

**Limits of Bifrost**

- Guardrails, clustering, adaptive routing, SSO, role-based access and audit logs need the
  Enterprise build, which has no public price.
- There is no Python library. Python apps call the Bifrost server.

Sources: [repository](https://github.com/maximhq/bifrost),
[budgets and limits](https://github.com/maximhq/bifrost/blob/main/docs/features/governance/budget-and-limits.mdx),
[semantic caching](https://github.com/maximhq/bifrost/blob/main/docs/features/semantic-caching.mdx),
[benchmarks](https://github.com/maximhq/bifrost/blob/main/docs/benchmarking/getting-started.mdx),
[pricing](https://www.getmaxim.ai/bifrost/pricing),
[enterprise](https://www.getmaxim.ai/bifrost/enterprise).

### 3. Apache APISIX

APISIX vs LiteLLM: APISIX is an Apache-2.0 API gateway with AI plugins for proxying, load
balancing, caching and token rate limits.

**Best for:** teams that already route their other APIs through APISIX.

| | Apache APISIX | LiteLLM |
|---|---|---|
| License | Apache-2.0, from the Apache Software Foundation | MIT; `enterprise/` folder commercial |
| Self-host | The APISIX server and etcd, or a standalone config file; Redis for the AI cache | Postgres; Redis for more than one instance |
| Providers | 10 drivers, including any OpenAI-compatible API | 100+ |

**Where APISIX differs**

- The `ai-proxy-multi` plugin balances load, retries, falls back on a 429 or a 5xx, and runs
  health checks.
- The `ai-cache` plugin, added in 3.18.0, has an exact cache and an optional semantic cache in
  Redis, and it caches streamed replies too.
- Other plugins add prompt guards, prompt templates and content moderation.

**Limits of APISIX**

- The docs describe token rate limits, but no dollar budgets and no virtual keys.
- APISIX is a server only, with no library mode.

Sources: [plugins](https://github.com/apache/apisix/tree/master/apisix/plugins),
[ai-proxy-multi](https://github.com/apache/apisix/blob/master/docs/en/latest/plugins/ai-proxy-multi.md),
[ai-cache](https://github.com/apache/apisix/blob/master/docs/en/latest/plugins/ai-cache.md),
[openapi-to-mcp](https://github.com/apache/apisix/blob/master/docs/en/latest/plugins/openapi-to-mcp.md),
[changelog](https://github.com/apache/apisix/blob/master/CHANGELOG.md).

### 4. Agent Router (formerly Envoy AI Gateway)

Agent Router vs LiteLLM: Agent Router is the new name of Envoy AI Gateway, an Apache-2.0 project
built on Envoy. The Agentic AI Foundation now governs it.

**Best for:** platform teams that run Envoy or Kubernetes and want LLM traffic in the same
layer.

| | Agent Router | LiteLLM |
|---|---|---|
| License | Apache-2.0, with no enterprise tier | MIT; `enterprise/` folder commercial |
| Self-host | `aigw run`, or Kubernetes with Envoy Gateway; Redis for token limits | Postgres; Redis for more than one instance |
| Library mode | Not offered; server only | Python SDK |

**Where Agent Router differs**

- Token rate limits work per user and per model. A rule can count a cost you define instead of
  raw tokens.
- A token quota per backend returns a 429 when it runs out.
- An MCP gateway combines several MCP servers, with OAuth and tool filtering.
- Traces use the OpenInference conventions by default, and can switch to the OpenTelemetry
  conventions for generative AI.

**Limits of Agent Router**

- The docs describe no response cache and no virtual keys.
- Quotas count tokens, not dollars.
- Routing for A2A, the agent-to-agent protocol, is still in preview.

Sources: [repository and rename](https://github.com/theagentrouter/agent-router#formerly-envoy-ai-gateway),
[rate limits](https://github.com/theagentrouter/agent-router/blob/main/site/docs/capabilities/traffic/usage-based-ratelimiting.md),
[quota policy](https://github.com/theagentrouter/agent-router/blob/main/site/docs/capabilities/traffic/quota-policy.md),
[MCP](https://github.com/theagentrouter/agent-router/blob/main/site/docs/capabilities/mcp/index.md),
[A2A](https://github.com/theagentrouter/agent-router/blob/main/site/docs/capabilities/a2a/index.md).

### 5. Portkey

Portkey vs LiteLLM: Portkey's open-source gateway is MIT and runs with one `npx` command.
Fallbacks, load balancing and guardrails are free, but budgets and rate limits per key are on
the Enterprise plan.

**Best for:** teams that want a light gateway with routing and guardrails, and a hosted log
viewer.

| | Portkey | LiteLLM |
|---|---|---|
| License | MIT gateway | MIT; `enterprise/` folder commercial |
| Self-host | `npx @portkey-ai/gateway`, Docker or Cloudflare Workers | Postgres; Redis for more than one instance |
| Budgets and rate limits | Enterprise plan (and some Pro customers) | Free |
| Cheapest paid plan | Production: $49 a month, 100,000 logs | Enterprise, no public price |

**Where Portkey differs**

- The gateway retries up to five times with backoff, and routes on conditions you set.
- The README lists more than 40 guardrails, plus plugins from partners.
- The exact-match cache stores replies in memory, files, Redis or Cloudflare KV.

**Limits of Portkey**

- Palo Alto Networks completed its purchase of Portkey on 29 May 2026. Portkey is now part of
  Prisma AIRS, the Palo Alto Networks product for AI security.
- The open-source repository's last commit was on 25 May 2026, and its last release was v1.15.2,
  in January 2026.
- The semantic cache and prompt management are in the hosted and enterprise versions only.

Sources: [repository](https://github.com/Portkey-AI/gateway),
[pricing](https://portkey.ai/pricing),
[acquisition](https://www.paloaltonetworks.com/company/press/2026/palo-alto-networks-completes-acquisition-of-portkey-to-secure-ai-agents).

### 6. Kong AI Gateway

Kong vs LiteLLM: Kong is an Apache-2.0 API gateway with AI plugins. The free core proxies LLM
calls. Load balancing and the semantic cache, which LiteLLM includes for free, need Kong
Enterprise.

**Best for:** teams that already run Kong for their other APIs.

| | Kong AI Gateway | LiteLLM |
|---|---|---|
| License | Apache-2.0 core; advanced AI plugins need Enterprise | MIT; `enterprise/` folder commercial |
| Self-host | Postgres, or no database | Postgres; Redis for more than one instance |
| Providers in the free core | 9 | 100+ |
| Cheapest hosted plan | Konnect Plus: from $25 a month, plus $100 a month for each model | No hosted price |

**Where Kong differs**

- The free core has plugins for prompt templates, prompt guards and request and response
  transforms.
- The Enterprise load balancer has seven algorithms, including lowest latency and semantic.
- Kong sells metering and billing, so you can charge your own customers for AI use.

**Limits of Kong**

- Load balancing, failover, the semantic cache and limits on tokens or cost are Enterprise
  plugins.
- The open-source edition has had only patch releases since 3.9 came out in December 2024. Its
  newest patch, 3.9.4, came out in October 2026.

Sources: [license](https://github.com/Kong/kong/blob/master/LICENSE),
[AI Gateway](https://developer.konghq.com/ai-gateway/),
[AI Proxy Advanced](https://developer.konghq.com/plugins/ai-proxy-advanced/),
[open-source AI drivers](https://github.com/Kong/kong/tree/master/kong/llm/drivers),
[open-source plugins](https://github.com/Kong/kong/tree/master/kong/plugins),
[pricing](https://konghq.com/pricing).

### 7. Helicone

Helicone vs LiteLLM: Helicone is an Apache-2.0 observability platform with a gateway. Each call
is logged with its cost, and the gateway can send a call to the cheapest provider for a model.

**Best for:** teams that mainly want request logs and cost tracking, with a gateway in front.

| | Helicone | LiteLLM |
|---|---|---|
| License | Apache-2.0 | MIT; `enterprise/` folder commercial |
| Self-host | Web app, the Jawn API, Postgres, ClickHouse, MinIO | Postgres; Redis for more than one instance |
| Cheapest paid plan | Pro: $79 a month | Enterprise, no public price |

**Where Helicone differs**

- The hosted gateway can use your own provider keys or Helicone credits, which carry 0%
  markup.
- A rate-limit header can limit calls by count, by cost or by a custom property.
- Helicone versions prompts and serves them through the gateway.

**Limits of Helicone**

- Mintlify announced it was buying Helicone on 3 March 2026 and said Helicone would run in
  maintenance mode. In October 2026, Helicone's website says it is no longer part of Mintlify,
  with no other details.
- A self-hosted install runs five services, including Postgres and ClickHouse, packaged in one
  container. LLM calls go through a separate AI Gateway.

Our comparison: [AcruxCore vs Helicone](/blog/acruxcore-vs-helicone).

Sources: [repository](https://github.com/Helicone/helicone),
[gateway](https://docs.helicone.ai/gateway/overview),
[provider routing](https://docs.helicone.ai/gateway/provider-routing),
[self-hosting](https://docs.helicone.ai/getting-started/self-host/docker),
[pricing](https://www.helicone.ai/pricing),
[Mintlify post](https://www.mintlify.com/blog/mintlify-acquires-helicone).

## Hosted LiteLLM alternatives

These four tools run on the vendor's servers by default, so you have no proxy to deploy or
upgrade. None of the four is open source.

### 8. Cloudflare AI Gateway

Cloudflare vs LiteLLM: Cloudflare runs the gateway on its own network. Analytics, caching and
rate limits are free, and token prices carry no markup.

**Best for:** teams that want LiteLLM's logging, caching and limits without running a server.

| | Cloudflare AI Gateway | LiteLLM |
|---|---|---|
| License | Closed source | MIT; `enterprise/` folder commercial |
| Where it runs | Cloudflare's network | Your servers |
| Fee | None on tokens; 5% on Unified Billing credits | None |
| Logs | Older accounts: 100,000 on Workers Free, 10 million per gateway on Workers Paid. Newer accounts: Workers Logs pricing | Your own database |

**Where Cloudflare differs**

- Dynamic routing sets retries, fallbacks and percentage splits between models.
- Spend limits return a 429 when they run out.
- Unified Billing lets you pay for several providers through Cloudflare, for a 5% fee on
  credits.

**Limits of Cloudflare**

- Spend limits are eventually consistent, so a burst of calls at once can pass the limit.
- The cache matches identical requests only. Cloudflare says semantic caching is planned.
- Accounts that created their first gateway on or after 24 September 2026 pay Workers Logs
  pricing for logs. The log limits in the table above apply only to older accounts.

Sources: [AI Gateway](https://developers.cloudflare.com/ai-gateway/),
[pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/),
[spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/),
[caching](https://developers.cloudflare.com/ai-gateway/features/caching/),
[dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/).

### 9. Vercel AI Gateway

Vercel vs LiteLLM: Vercel's gateway charges no markup and no platform fee on tokens. Your app
does not need to run on Vercel.

**Best for:** teams that want one bill for many providers, with no fee on tokens.

| | Vercel AI Gateway | LiteLLM |
|---|---|---|
| License | Closed source | MIT; `enterprise/` folder commercial |
| Where it runs | Vercel's servers | Your servers |
| Fee | None on tokens; card fees may apply | None |
| Models | About 500 in its models API | 100+ providers |

**Where Vercel differs**

- Fallbacks work across providers and across models.
- Budgets work per team, project, key or user.
- Request logs and traces hold metadata only, such as model, tokens, latency and cost, and no
  prompt or reply text.

**Limits of Vercel**

- A budget is a soft cap, so the call that crosses it still completes. Spend on your own keys
  does not count toward it.
- You cannot set your own rate limits.
- A call with your own key that fails is retried on Vercel's keys and billed to your credits.
  Using your own keys also needs credits you have bought.

Sources: [AI Gateway](https://vercel.com/docs/ai-gateway),
[pricing](https://vercel.com/docs/ai-gateway/pricing),
[budgets](https://vercel.com/docs/ai-gateway/observability-and-spend/budgets),
[trace drains](https://vercel.com/docs/ai-gateway/observability-and-spend/trace-drains),
[rate limits](https://vercel.com/docs/ai-gateway/rate-limits).

### 10. TrueFoundry AI Gateway

TrueFoundry vs LiteLLM: TrueFoundry sells an enterprise gateway with budgets, rate limits, a
semantic cache, guardrails and an MCP gateway. It runs hosted, or in your own cloud on the
Enterprise plan.

**Best for:** companies that want a supported, commercial gateway with role-based access and
an MCP gateway.

| | TrueFoundry | LiteLLM |
|---|---|---|
| License | Closed source | MIT; `enterprise/` folder commercial |
| Self-host | Enterprise: the gateway in your cloud, about $600 a month of hosting with TrueFoundry's control plane, or $800 to $1,000 with both | Free |
| Hosted price | Developer free for 3 users; Pro $25 per user a month | No hosted price |
| Requests included | Pro: 20,000 per user a month, then $20 per 100,000 | No limit on your own servers |

**Where TrueFoundry differs**

- USD budgets per user, team, model or metadata block calls once they run out, or only warn.
- Rate limits work per user, team, model or request metadata.
- The cache has exact and semantic modes.
- TrueFoundry's own benchmark, on one CPU against a fake OpenAI endpoint, reports 3 ms of
  added latency at 10 to 50 requests a second. On the same setup, it reports 15 to 26 ms for
  LiteLLM.

**Limits of TrueFoundry**

- Pro charges per user, and Enterprise is priced by contract.
- Running the gateway in your own cloud needs the Enterprise plan.

Sources: [AI Gateway](https://www.truefoundry.com/ai-gateway),
[deployment modes](https://www.truefoundry.com/docs/ai-gateway/modes-of-deployment),
[pricing](https://www.truefoundry.com/pricing),
[caching](https://www.truefoundry.com/docs/ai-gateway/caching),
[benchmark](https://www.truefoundry.com/blog/truefoundry-llm-gateway-is-blazing-fast).

### 11. OpenRouter

OpenRouter vs LiteLLM: OpenRouter sells model access from one balance, so you need no provider
accounts. LiteLLM uses your own provider keys.

**Best for:** teams that want one bill and no provider accounts at all.

| | OpenRouter | LiteLLM |
|---|---|---|
| License | Closed source | MIT; `enterprise/` folder commercial |
| Who bills you for tokens | OpenRouter, from credits | Each provider |
| Fee | 5.5% on credit purchases; 8% on Business | None |
| Your own keys | No fee on the first $25,000 of use a month, then 5% | Always |

**Where OpenRouter differs**

- Budgets in USD block calls once they run out.
- An exact-match cache serves repeat requests, and a cache hit costs nothing.
- Guardrails cover model allowlists, provider allowlists and PII redaction.

**Limits of OpenRouter**

- OpenRouter cannot be self-hosted. Every call goes through its servers.
- Free models are capped at 50 requests a day, or 1,000 a day once you have bought $10 of
  credits. Budgets and caching are on the pay-as-you-go plan, not the Free plan.

Sources: [pricing](https://openrouter.ai/pricing),
[BYOK](https://openrouter.ai/docs/guides/overview/auth/byok.md),
[spend controls](https://openrouter.ai/docs/guides/best-practices/spend-controls.md),
[response caching](https://openrouter.ai/docs/guides/features/response-caching.md).

## Libraries that replace `litellm.completion()`

These three tools run inside your app, with no server. Each one replaces LiteLLM's library, not
its proxy, so none of them has budgets or virtual keys for a team.

| Library | Language | License | Providers | Retries | Fallbacks | Newest release |
|---|---|---|---|---|---|---|
| any-llm | Python | Apache-2.0 | 55 | Yes: through most providers' SDKs | No | 1.39.0, 21 October 2026 |
| LangChain | Python and JavaScript | MIT | 30 provider keys in `init_chat_model` | Yes: the provider SDK's default in Python, 6 in JavaScript | Yes: through agent middleware or `.with_fallbacks()` | `langchain` 1.4.7, 21 October 2026 |
| Vercel AI SDK | TypeScript | Apache-2.0 | About 50 provider packages | Yes, 2 by default | No: through Vercel AI Gateway | `ai` 7.0.149, 22 October 2026 |

### 12. any-llm

any-llm vs LiteLLM: any-llm, from Mozilla.ai, calls each provider through that provider's
official SDK where one exists. Its README presents it as a LiteLLM replacement.

**Best for:** Python code that calls `litellm.completion()` and needs nothing more.

- Moving over changes the import and the model strings.
- Budgets and virtual keys live in a separate Mozilla.ai gateway, Otari.
- any-llm passes `max_retries` to most providers' official SDKs. Some, such as Bedrock and
  Mistral, reject it. It has no fallbacks and no response cache.

Sources: [repository](https://github.com/mozilla-ai/any-llm),
[providers](https://docs.mozilla.ai/any-llm/providers/).

### 13. LangChain

LangChain vs LiteLLM: LangChain is a framework for building LLM apps, and `init_chat_model` is
its one function for many providers. LiteLLM covers only the provider layer, as a library or a
proxy.

**Best for:** apps that already use LangChain or LangGraph.

- `init_chat_model("openai:gpt-4o")` builds a chat model from a `provider:model` string.
- Each provider needs its own package, such as `langchain-openai` or `langchain-aws`.
- Agent middleware (`create_agent`) adds fallbacks, retries and limits on the number of calls.
  A plain chat model gets fallbacks through `.with_fallbacks()`.
- The `langchain-litellm` package lets LangChain call models through LiteLLM, so the two can
  work together.

Sources: [init_chat_model](https://reference.langchain.com/python/langchain/chat_models/base/init_chat_model),
[models](https://docs.langchain.com/oss/python/langchain/models),
[middleware](https://docs.langchain.com/oss/python/langchain/middleware/built-in).

### 14. Vercel AI SDK

Vercel AI SDK vs LiteLLM: the AI SDK is a TypeScript library with one API for about 50 provider
packages. LiteLLM's library is Python only.

**Best for:** TypeScript and Node apps.

- `maxRetries` retries a failed call twice by default.
- Caching is a middleware you write yourself.
- Fallbacks across providers come through Vercel AI Gateway, not the SDK.

Sources: [introduction](https://ai-sdk.dev/docs/introduction),
[providers](https://ai-sdk.dev/providers/ai-sdk-providers),
[settings](https://ai-sdk.dev/docs/ai-sdk-core/settings),
[caching](https://ai-sdk.dev/docs/advanced/caching).

## About AcruxCore

AcruxCore is our own product, so it has no rank in this list.

AcruxCore vs LiteLLM: AcruxCore has a gateway with budgets, rate limits and fallbacks, like
LiteLLM. It also versions prompts, traces every call and runs evals. LiteLLM's prompt manager is
in beta, and LiteLLM leaves evals and full traces to other tools.

**Best for:** teams that want to replace LiteLLM and the tools around it with one app on their
own servers.

| | AcruxCore | LiteLLM |
|---|---|---|
| License | Apache-2.0, with no enterprise folder | MIT; `enterprise/` folder commercial |
| Self-host | Postgres, Redis, API, worker, web | Postgres; Redis for more than one instance |
| Providers | OpenAI, Anthropic and Gemini, plus any OpenAI-compatible base URL | 100+ |
| Prompts, traces, evals | Built in | Prompts in beta; traces and evals through other tools |
| Audit log and roles | Free | Enterprise |

**Where AcruxCore differs**

- A spend budget for the team or for one key refuses a call with a 402 error before the call
  reaches the provider. Budgets run per day, week, month or in total.
- Each gateway key can have its own limit on requests and tokens per minute.
- Each model can have an ordered list of fallback models. The gateway retries a 429, a 5xx or a
  network error with backoff, then moves to the next model.
- Every gateway call writes a trace span with tokens, cost and latency.
- The gateway renders a stored prompt by its alias, such as `production`. You change the prompt
  in the dashboard, and no code changes.
- Experiments run several prompt versions on several models against one dataset. Online rules
  score a sample of live calls with a judge model.
- In our October 2026 measurement, a local AcruxCore gateway added a median of 9 ms over a
  direct OpenAI call. The 95% confidence interval runs from −15 ms to +28 ms, so the test cannot
  tell the gateway apart from a direct call.

**Limits of AcruxCore**

- If you need many providers, LiteLLM has more. AcruxCore has adapters for OpenAI, Anthropic
  and Gemini, and reaches others through an OpenAI-compatible base URL.
- If you need load balancing across several deployments of one model, LiteLLM has it.
  AcruxCore maps each model name to one provider connection.
- If you call models from inside a Python process with no server, LiteLLM's library does that.
  The AcruxCore SDKs call the AcruxCore server.
- The gateway serves the OpenAI chat completions format only. LiteLLM also serves embeddings,
  the Responses API and the Anthropic Messages format.
- AcruxCore counts rate limits inside each API process. Several API instances do not share one
  count.
- AcruxCore has no semantic cache and no MCP gateway. Its MCP server lets MCP clients use
  AcruxCore's own prompts, gateway and evals, but it does not proxy other MCP servers.
- The repository went public in August 2026 and has 11 GitHub stars.

Our measurements: [gateway overhead](/blog/llm-gateway-overhead),
[exact-match caching](/blog/exact-match-gateway-caching). The setup guides start at
[Route calls through the gateway](https://docs.acruxcore.com/docs/guides/route-calls-through-the-gateway).

Sources: [license](https://github.com/AcruxCore/AcruxCore/blob/main/LICENSE),
[compose file](https://github.com/AcruxCore/AcruxCore/blob/main/docker-compose.local.yml),
[pricing](https://acruxcore.com/pricing).

## Tools other lists still recommend

Older lists of LiteLLM alternatives still include these tools. Their status on 22 October 2026:

- **TensorZero** is no longer maintained. Its website says it "remains available on GitHub but
  is no longer maintained", and the repository is archived.
  ([source](https://www.tensorzero.com/))
- **Envoy AI Gateway** is now Agent Router, number 4 above.
  ([source](https://github.com/theagentrouter/agent-router#formerly-envoy-ai-gateway))
- **aisuite**, from Andrew Ng, has adapters for 28 providers. Its README describes no retries, fallbacks or
  cache. ([source](https://github.com/andrewyng/aisuite))

## Which LiteLLM alternative should you pick?

Start at the top and stop at the first question you answer yes to.

![Decision flow: only use the Python library leads to any-llm or LangChain; need prompts, traces and evals too leads to AcruxCore; already run MLflow leads to MLflow AI Gateway; want no server to run leads to Cloudflare or Vercel; already run an API gateway leads to Kong, APISIX or Agent Router; otherwise Bifrost](/img/blog/litellm-alternatives/04-decision.webp)

### Best open-source LiteLLM alternative

- **AcruxCore** (ours) or **MLflow AI Gateway** if you want the gateway, prompts, traces and
  evals in one app, free to self-host.
- **Bifrost** if you want a gateway only. Its free version has budgets, rate limits, load
  balancing, a semantic cache and an MCP gateway.

### Best self-hosted LiteLLM alternative for a platform team

- **Agent Router** if you run Envoy or Kubernetes.
- **Kong** or **APISIX** if you already route your other APIs through one of them.

### If you do not want to run a gateway

- **Cloudflare AI Gateway** has free analytics, caching and rate limits.
- **Vercel AI Gateway** adds no markup on tokens, with or without your own keys.
- **OpenRouter** if you want no provider accounts at all.

### If you only use the Python library

- **any-llm** for the same `completion()` call over official provider SDKs where they exist.
- **LangChain** if you are building with LangChain or LangGraph anyway.
- **Vercel AI SDK** if your app is in TypeScript.

## FAQ

### Was LiteLLM hacked?

Two LiteLLM releases on PyPI were malicious. On 24 March 2026, versions 1.82.7 and 1.82.8 were
live from 10:39 UTC for about 40 minutes, before PyPI quarantined them. LiteLLM says the
attacker bypassed its CI/CD workflows and uploaded the packages to PyPI directly. LiteLLM
believes the compromise came from the Trivy scanner in its CI pipeline.
([security update](https://docs.litellm.ai/blog/security-update-march-2026),
[The Register](https://www.theregister.com/2026/03/24/trivy_compromise_litellm/))

### What did the poisoned LiteLLM releases do?

The code collected environment variables, SSH keys, cloud credentials, Kubernetes tokens and
database passwords. It sent them to `models.litellm.cloud`, which LiteLLM says is not its
domain. Version 1.82.7 hid the payload in `proxy_server.py`. Version 1.82.8 also added a
`litellm_init.pth` file. Python reads `.pth` files when it starts, so that code could run even
when LiteLLM was never imported. LiteLLM told affected users to treat every credential on those
systems as compromised and rotate it.
([security update](https://docs.litellm.ai/blog/security-update-march-2026))

### Who was affected by the LiteLLM supply-chain attack?

The advisory's list of who may be affected uses a wider window than the 40 minutes. It names
anyone who installed LiteLLM with pip on 24 March 2026 between 10:39 and 16:00 UTC, including
through an unpinned dependency. The official LiteLLM proxy Docker image
was not affected, because it pins its dependencies. Both versions are gone from PyPI. LiteLLM
announced v1.83.0, a clean release, on 30 March, and it reached PyPI on 31 March.
([security update](https://docs.litellm.ai/blog/security-update-march-2026),
[v1.83.0 on PyPI](https://pypi.org/project/litellm/1.83.0/))

### Is LiteLLM open source?

Mostly. The repository is MIT, except the `enterprise/` folder. That folder is under the
BerriAI Enterprise license, which needs a paid subscription for production use.
([license](https://github.com/BerriAI/litellm/blob/main/LICENSE),
[enterprise license](https://github.com/BerriAI/litellm/blob/main/enterprise/LICENSE.md))

### What is the difference between LangChain and LiteLLM?

LiteLLM gives you one call for many providers, as a library or as a proxy server. LangChain is
a framework for building chains and agents, and it calls providers through its own packages.
The two can work together through the `langchain-litellm` package.
([LangChain models](https://docs.langchain.com/oss/python/langchain/models))

### LiteLLM vs Portkey: which should I use?

Both have fallbacks and load balancing in their free versions. LiteLLM also gives you budgets
and rate limits per key for free, while Portkey keeps those on its Enterprise plan.
Portkey's open-source repository has had no commit since 25 May 2026.
([Portkey pricing](https://portkey.ai/pricing), [LiteLLM](https://www.litellm.ai/))

### LiteLLM vs TrueFoundry: which is faster?

The only published comparison is TrueFoundry's own. On one CPU against a fake OpenAI endpoint,
it reports 3 ms of added latency for TrueFoundry and 15 to 26 ms for LiteLLM. LiteLLM's own
benchmark, on four instances against a mock endpoint, reports 8 ms of gateway overhead at the
95th percentile at 1,170 requests a second. Neither vendor ran the other's setup.
([TrueFoundry benchmark](https://www.truefoundry.com/blog/truefoundry-llm-gateway-is-blazing-fast),
[LiteLLM benchmarks](https://docs.litellm.ai/docs/benchmarks))

## Related posts

- [How much overhead does an LLM gateway add?](/blog/llm-gateway-overhead): five ways to reach
  the same OpenAI model, measured.
- [Exact-match gateway caching](/blog/exact-match-gateway-caching): the latency and cost a cache
  hit saves.
- [AcruxCore vs Helicone](/blog/acruxcore-vs-helicone): two request-path proxies, measured.
- [AcruxCore vs MLflow](/blog/acruxcore-vs-mlflow): two gateways, one with guardrails.
- [8 Langfuse alternatives](/blog/langfuse-alternatives): the same comparison, starting from
  Langfuse.
