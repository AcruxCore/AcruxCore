---
title: "8 LangSmith alternatives for startups: open source, self-hosted and cheaper (2026)"
description: "Eight LangSmith alternatives compared on license, free self-hosting, per-seat price and trace retention. Which ones are truly open source, and which fit a startup."
title_meta: "LangSmith Alternatives: 8 Open-Source Picks (2026)"
slug: langsmith-alternatives
date: 2026-10-17
authors: [acrux]
tags: [llmops-comparison, llm-tracing, prompt-management]
image: /img/blog/langsmith-alternatives/01-header.webp
keywords: [langsmith alternatives, alternatives to langsmith, best langsmith alternatives, langsmith competitors, open source langsmith alternative, self-hosted langsmith alternatives, best langsmith alternatives for startups, best free langsmith alternative]
---

![Eight LangSmith alternatives in a grid, each with what it is best for, coloured by license: Langfuse, AcruxCore, Opik, MLflow and Laminar open source, Arize Phoenix source-available, Braintrust and W&B Weave closed source](/img/blog/langsmith-alternatives/01-header.webp)

This post compares eight LangSmith alternatives on license, self-hosting, price and features.
For each alternative to LangSmith, it lists what the tool adds and what it lacks.

<!-- truncate -->

**The short answer**

- **Open source and free to self-host:** Langfuse, AcruxCore, Opik, MLflow and Laminar.
- **Tracing, prompts, evals and a gateway in one open-source tool:** AcruxCore or MLflow.
- **Evals first, hosted for you:** Braintrust.

## LangSmith competitors at a glance

**License and hosting**

| Tool | License | Self-host | Hosted free plan | Cheapest paid plan | Data kept on the paid plan |
|---|---|---|---|---|---|
| **LangSmith** | Closed source | Enterprise plan only | Developer: 5,000 traces, 1 seat, 14 days | Plus: $39 per seat a month | 14 days |
| Langfuse | MIT core; enterprise (`ee/`) folders commercial | Free | Hobby: 50,000 units, 2 users, 30 days | Core: $29 a month, unlimited users | 90 days |
| AcruxCore | Apache-2.0 | Free | Free; span content kept 90 days | None; the hosted plan is free | Not applicable |
| Opik | Apache-2.0 | Free | 25,000 spans a month, 10 members, 60 days | Pro: $19 a month, 50 members | 60 days |
| MLflow | Apache-2.0 | Free | None outside Databricks | Through Databricks | You decide |
| Laminar | Apache-2.0 | Free | 1 GB, 1 seat, 7 days | Starter: $30 a month, unlimited seats | 30 days |
| Arize Phoenix | Elastic License 2.0 | Free | Arize AX Free: 25,000 spans, 15 days | Arize AX Pro: $50 a month | 30 days |
| Braintrust | Closed source | Enterprise plan only | 1 GB, unlimited users, 14 days | Pro: $249 a month | 30 days |
| W&B Weave | SDK Apache-2.0; server not published | Needs W&B Self-Managed and a Weave license | 1 GB a month, 5 seats | Pro: from $60 a month, 10 seats | Not published |

**Features**

| Tool | Prompt versions | Gateway (your model calls pass through it) | Evals on datasets | Evals on live traffic | Status in 2026 |
|---|---|---|---|---|---|
| **LangSmith** | Yes | Beta | Yes | Yes | Active |
| Langfuse | Yes | No | Yes | Yes | Active; owned by ClickHouse since January 2026 |
| AcruxCore | Yes | Yes | Yes | Yes | Active; public since August 2026 |
| Opik | Yes | Beta, for development and testing | Yes | Yes | Active |
| MLflow | Yes | Yes | Yes | Yes | Active; a Linux Foundation project |
| Laminar | No | No | Yes | Signals (rules in plain English) | Active |
| Arize Phoenix | Yes | No | Yes | Yes | Active |
| Braintrust | Yes | Yes, hosted, in public preview | Yes | Yes | Active |
| W&B Weave | Partial | No | Yes | Yes | Active; W&B is owned by CoreWeave |

A **unit** on Langfuse is one trace, one step inside a trace, or one score. A **span** is one
step inside a trace. Opik, Phoenix and Braintrust count spans or gigabytes, so their free plans
are not directly comparable with LangSmith's 5,000 traces. **Closed source** means the vendor
publishes no server code.

![Three columns. Free with no ClickHouse: AcruxCore, MLflow, Arize Phoenix. Free but runs ClickHouse: Langfuse, Opik, Laminar. Needs a paid license: LangSmith, Braintrust, W&B Weave](/img/blog/langsmith-alternatives/03-selfhost.webp)

## Why teams look for a LangSmith alternative

- **Every seat costs money.** The Plus plan costs $39 per seat a month. Three people pay $117 a
  month before they pay for extra traces.
- **Traces are kept 14 days.** Base traces on Free and Plus are deleted after 14 days. Extended
  traces are kept 180 days for an extra fee.
- **Self-hosting needs Enterprise.** LangSmith self-hosting is an add-on to the Enterprise plan.
  Self-hosted LangSmith runs on Kubernetes with ClickHouse, PostgreSQL and Redis. It needs a
  license key from sales.
- **The platform is not open source.** The SDKs are MIT. The server ships only as container
  images that need a license key.

LangSmith does not need LangChain for tracing. Its `traceable` decorator and its OpenTelemetry
endpoint work with any code.

![Four reasons teams look past LangSmith: per-seat price, base traces kept 14 days, self-hosting only on Enterprise, and a closed server; plus one point in its favour: it does not need LangChain](/img/blog/langsmith-alternatives/02-why.webp)

Sources: LangSmith [pricing](https://www.langchain.com/pricing),
[billing](https://docs.langchain.com/langsmith/billing),
[self-hosting](https://docs.langchain.com/langsmith/architectural-overview) and
[OpenTelemetry](https://docs.langchain.com/langsmith/trace-with-opentelemetry) pages.

## How we picked

- **The tool does LangSmith's core jobs:** tracing, and at least one of prompts or evals.
- **The tool is active today.** Each tool had a release or a commit in October 2026.
- **The price is public**, or the tool is free to self-host.
- **Every fact comes from the vendor:** the pricing page, the docs, the license file or the
  repository's compose file, read on 17 October 2026. We do not use other comparison lists as
  sources.

## Open-source LangSmith alternatives (free to self-host)

These five tools use a license approved by the Open Source Initiative. You can run every one of
them on your own servers without paying.

### 1. Langfuse

Langfuse vs LangSmith: Langfuse is open source and free to self-host, and LangSmith is neither.

**Best for:** teams that want the open-source tool with the largest community for tracing,
prompts and evals.

| | Langfuse | LangSmith |
|---|---|---|
| License | MIT core; enterprise (`ee/`) folders under a commercial license | Closed source |
| Self-host | Free: web, worker, Postgres, ClickHouse, Redis, S3 storage | Enterprise plan only |
| Cheapest paid plan | Core: $29 a month, 100,000 units, unlimited users, 90 days | Plus: $39 per seat a month, 10,000 traces, 14 days |
| Gateway | No | Beta |

**Where Langfuse differs**

- Langfuse charges one flat price for the whole team on Core. LangSmith charges per seat.
- Langfuse keeps data 90 days on Core. LangSmith keeps base traces 14 days on Plus.
- Langfuse has the largest community here: 35,957 GitHub stars.
- Datasets, experiments, LLM-as-judge on live traces and review queues are all in the free
  self-hosted version.

**Limits of Langfuse**

- Langfuse has no gateway. The Langfuse docs use LiteLLM as the gateway.
- A self-hosted install runs four data stores: Postgres, ClickHouse, Redis and S3.
- Audit logs, project-level roles and retention controls need an enterprise license, even when
  you self-host.

We compared both tools on one app in
[Langfuse vs LangSmith](/blog/langfuse-vs-langsmith).

Sources: [license](https://github.com/langfuse/langfuse/blob/main/LICENSE),
[pricing](https://langfuse.com/pricing),
[self-host pricing](https://langfuse.com/pricing-self-host),
[compose file](https://github.com/langfuse/langfuse/blob/main/docker-compose.yml),
[ClickHouse acquisition](https://clickhouse.com/blog/clickhouse-acquires-langfuse-open-source-llm-observability).

### 2. AcruxCore

AcruxCore vs LangSmith: both cover prompts, tracing and evals. AcruxCore is Apache-2.0 and free
to self-host, and its gateway sends your model calls to the provider.

**Best for:** small teams that want prompts, a gateway, traces and evals in one self-hosted app.

| | AcruxCore | LangSmith |
|---|---|---|
| License | Apache-2.0, no enterprise folder | Closed source |
| Self-host | Free: Postgres, Redis, API, worker, web | Enterprise plan only |
| Cheapest paid plan | None; the hosted plan is free to use | Plus: $39 per seat a month |
| Gateway | Yes | Beta |

**Where AcruxCore differs**

- The gateway is part of the product. It holds your provider keys, caches responses, falls back
  to a second model, and stops calls at a spend budget or a rate limit.
- You define the tools a model can call and keep versions of them. AcruxCore runs a tool when
  your code calls its API.
- Roles and the audit log are free in every AcruxCore install. LangSmith keeps custom roles for
  Enterprise.
- Self-hosting needs two data stores, Postgres and Redis, with no ClickHouse.

**Limits of AcruxCore**

- The AcruxCore repository went public in August 2026 and has 11 GitHub stars.
- AcruxCore has no SAML or OIDC single sign-on. Sign-in is email or Google.
- The gateway supports OpenAI, Anthropic, Gemini and OpenAI-compatible APIs. The SDKs are Python
  and TypeScript only.

Our longer comparison is [AcruxCore vs LangSmith](/blog/acrux-core-vs-langsmith).

Sources: [license](https://github.com/AcruxCore/AcruxCore/blob/main/LICENSE),
[compose file](https://github.com/AcruxCore/AcruxCore/blob/main/docker-compose.local.yml),
[pricing](https://acruxcore.com/pricing).

### 3. Opik

Opik vs LangSmith: Opik is Apache-2.0 from end to end and has the cheapest paid plan here.

**Best for:** teams that want open-source evals and automatic prompt optimization.

| | Opik | LangSmith |
|---|---|---|
| License | Apache-2.0 | Closed source |
| Self-host | Free: MySQL, Redis, ClickHouse, ZooKeeper, MinIO, three app services | Enterprise plan only |
| Cheapest paid plan | Pro: $19 a month, 100,000 spans, up to 50 members, 60 days | Plus: $39 per seat a month |
| Gateway | Beta, for development and testing | Beta |

**Where Opik differs**

- Opik ships an optimizer package that rewrites prompts and agents for you, with six
  optimization algorithms.
- Opik has guardrails for PII, topics and prompt injection.
- Opik's free cloud plan allows 10 members. LangSmith's free plan allows 1 seat.

**Limits of Opik**

- The self-hosted version has no user management.
- A self-hosted install runs five data stores: MySQL, Redis, ClickHouse, ZooKeeper and MinIO.
- The Opik docs describe the Opik gateway as beta, for development and testing.

Our comparison: [AcruxCore vs Opik](/blog/acruxcore-vs-opik).

Sources: [README and license](https://github.com/comet-ml/opik/blob/main/README.md),
[pricing](https://www.comet.com/site/pricing/),
[self-hosting](https://www.comet.com/docs/opik/self-host/overview),
[compose file](https://github.com/comet-ml/opik/blob/main/deployment/docker-compose/docker-compose.yaml),
[gateway](https://www.comet.com/docs/opik/integrations/opik-llm-gateway),
[optimizer](https://github.com/comet-ml/opik/blob/main/sdks/opik_optimizer/README.md).

### 4. MLflow

MLflow vs LangSmith: MLflow is an Apache-2.0 ML platform with tracing, a prompt registry,
judges and a gateway in one server.

**Best for:** teams that already run MLflow for classic machine learning.

| | MLflow | LangSmith |
|---|---|---|
| License | Apache-2.0, Linux Foundation | Closed source |
| Self-host | Free: `pip install mlflow` and `mlflow server` on SQLite; Postgres and S3 storage for production | Enterprise plan only |
| Cheapest paid plan | No public price; the managed version comes with Databricks | Plus: $39 per seat a month |
| Gateway | Yes | Beta |

**Where MLflow differs**

- MLflow can run as one Python process with a SQLite file, with no Docker.
- The gateway splits traffic by weight, falls back to another model, and rejects calls over a
  USD budget.
- Judges can score live traces with no code change, and review queues assign traces to people.
- The same server holds your training runs and model registry.

**Limits of MLflow**

- MLflow has no hosted plan of its own. The managed version needs a Databricks workspace.

Our comparison: [AcruxCore vs MLflow](/blog/acruxcore-vs-mlflow).

Sources: [license](https://raw.githubusercontent.com/mlflow/mlflow/master/LICENSE.txt),
[GenAI docs](https://mlflow.org/docs/latest/genai/),
[self-hosting](https://mlflow.org/docs/latest/self-hosting/),
[compose file](https://raw.githubusercontent.com/mlflow/mlflow/master/docker-compose/docker-compose.yml),
[managed MLflow](https://www.databricks.com/product/managed-mlflow).

### 5. Laminar

Laminar vs LangSmith: Laminar is open-source tracing built for agents, with SQL over your traces.

**Best for:** teams that run agents with many steps, or agents that use a browser.

| | Laminar | LangSmith |
|---|---|---|
| License | Apache-2.0; Signals and alerts need a license key when self-hosted | Closed source |
| Self-host | Free: Postgres, ClickHouse, Quickwit, frontend, app server | Enterprise plan only |
| Cheapest paid plan | Starter: $30 a month, 3 GB, unlimited seats, 30 days | Plus: $39 per seat a month, 14 days |
| Gateway | No | Beta |

**Where Laminar differs**

- Laminar replays a browser agent's session as video, next to the matching steps of the trace.
- You can query traces, spans and metrics with SQL.
- Signals are rules written in plain English, such as "agent is stuck in a loop". Laminar
  checks every trace against these rules.

**Limits of Laminar**

- Laminar has no prompt management, so you need another tool to version prompts.
- Laminar's free cloud plan keeps data 7 days, and Starter keeps data 30 days.

Our comparison: [AcruxCore vs Laminar](/blog/acruxcore-vs-laminar).

Sources: [repository](https://github.com/lmnr-ai/lmnr),
[compose file](https://github.com/lmnr-ai/lmnr/blob/main/docker-compose.yml),
[pricing](https://laminar.sh/pricing).

## Source-available: Arize Phoenix

### 6. Arize Phoenix

Phoenix vs LangSmith: Phoenix is free to self-host with no feature limits. Its license, the
Elastic License 2.0, is not approved by the Open Source Initiative.

**Best for:** engineers who want free self-hosted tracing and evals built on OpenTelemetry.

| | Arize Phoenix | LangSmith |
|---|---|---|
| License | Elastic License 2.0 | Closed source |
| Self-host | Free: one container, SQLite or Postgres | Enterprise plan only |
| Cheapest paid plan | Arize AX Pro: $50 a month, 50,000 spans, unlimited users, 30 days | Plus: $39 per seat a month |
| Gateway | No | Beta |

**Where Phoenix differs**

- The Elastic License forbids selling Phoenix to others as a hosted service. Running Phoenix for
  your own team is allowed.
- Self-hosting takes one container, or `pip install arize-phoenix` and `phoenix serve`, with
  SQLite.
- Tracing uses OpenInference, Arize's OpenTelemetry conventions, so any OpenTelemetry language
  can send spans.
- Prompts have versions and tags, and the playground replays a traced model call.

**Limits of Phoenix**

- The hosted plans are small: 25,000 spans on Free and 50,000 on Pro.
- On the hosted Arize AX plans, single sign-on and audit logs need Enterprise.

Our comparison: [AcruxCore vs Phoenix](/blog/acruxcore-vs-phoenix).

Sources: [license](https://github.com/Arize-ai/phoenix/blob/main/LICENSE),
[self-hosting](https://arize.com/docs/phoenix/self-hosting),
[compose file](https://github.com/Arize-ai/phoenix/blob/main/docker-compose.yml),
[pricing](https://arize.com/pricing).

## Hosted, closed-source alternatives

Braintrust and W&B Weave publish no server code, like LangSmith. Self-hosting either one needs an
enterprise contract.

### 7. Braintrust

Braintrust vs LangSmith: both are closed source and hosted. Braintrust charges a flat price with
unlimited users, and LangSmith charges per seat.

**Best for:** teams whose main work is evals and experiments.

| | Braintrust | LangSmith |
|---|---|---|
| License | Closed source; SDKs Apache-2.0 | Closed source; SDKs MIT |
| Self-host | Enterprise only; your data stays in your cloud, Braintrust hosts the UI | Enterprise only |
| Cheapest paid plan | Pro: $249 a month, 5 GB, unlimited users, 30 days | Plus: $39 per seat a month |
| Gateway | Yes, hosted, in public preview | Beta |

**Where Braintrust differs**

- Loop is an agent inside Braintrust. It reads your logs and experiments, then edits prompts,
  scorers and datasets after you approve.
- The gateway caches responses for up to 7 days and falls back to another provider on errors.
- Braintrust gives Pro free for 6 to 12 months to startups that qualify. LangSmith gives up to
  $10,000 in credits to startups with venture funding.

**Limits of Braintrust**

- Braintrust's free plan keeps data 14 days.
- Prompt environments need Pro.
- The Braintrust gateway has no uptime guarantee (SLA) while it is in preview.

Our comparison: [AcruxCore vs Braintrust](/blog/acruxcore-vs-braintrust).

Sources: [pricing](https://www.braintrust.dev/pricing),
[self-hosting](https://www.braintrust.dev/docs/admin/self-hosting),
[gateway](https://www.braintrust.dev/docs/deploy/gateway),
[Loop](https://www.braintrust.dev/docs/guides/loop).

### 8. W&B Weave

Weave vs LangSmith: Weave puts LLM traces and evals next to Weights & Biases experiment tracking.

**Best for:** teams that already use Weights & Biases.

| | W&B Weave | LangSmith |
|---|---|---|
| License | SDK Apache-2.0; the trace server is not published | Closed source |
| Self-host | Needs W&B Self-Managed, a Weave license from W&B support, Kubernetes and a ClickHouse cluster | Enterprise plan only |
| Cheapest paid plan | Pro: from $60 a month, 10 seats, 1.5 GB of traces a month | Plus: $39 per seat a month |
| Gateway | No | Beta |

**Where Weave differs**

- One subscription covers W&B experiment tracking and Weave traces.
- Monitors run LLM-judge checks, such as hallucination, on every production trace.
- The playground compares models side by side, using provider keys stored as team secrets.

**Limits of Weave**

- Pro includes 1.5 GB of traces a month.
- The pricing page does not state how long traces are kept.

Sources: [pricing](https://wandb.ai/site/pricing),
[README](https://github.com/wandb/weave/blob/master/README.md),
[self-managed Weave](https://docs.coreweave.com/weave/guides/platform/weave-self-managed.md),
[monitors](https://docs.coreweave.com/weave/guides/evaluation/monitors.md),
[CoreWeave acquisition](https://coreweave.com/blog/coreweave-completes-acquisition-of-weights-biases).

## Tools other lists still recommend

Older lists of LangSmith alternatives still include these five tools. Their status on
17 October 2026:

- **Helicone** was acquired by Mintlify in March 2026. The service runs in maintenance mode: it
  gets security fixes, bug fixes and new models, but no new features.
  ([source](https://www.helicone.ai/blog/joining-mintlify))
- **Portkey** was acquired by Palo Alto Networks in May 2026. The open-source gateway repository
  has had no merged code since 25 May 2026.
  ([source](https://www.paloaltonetworks.com/company/press/2026/palo-alto-networks-completes-acquisition-of-portkey-to-secure-ai-agents))
- **Humanloop** shut down on 8 September 2025.
  ([source](https://humanloop.com/docs/guides/migrating-from-humanloop))
- **Traceloop** announced in March 2026 that it is joining ServiceNow. Its OpenLLMetry library
  stays open source and active. ([source](https://traceloop.com/blog/traceloop-is-joining-servicenow))
- **Galileo** was acquired by Cisco and is now sold as Splunk Agent Observability. It is
  closed source. ([source](https://www.splunk.com/en_us/about-splunk/acquisitions/galileo.html))

## Which LangSmith alternative should you pick?

Start at the top and stop at the first question you answer yes to.

![Decision flow: self-host without ClickHouse leads to AcruxCore, MLflow or Phoenix; otherwise the biggest open community leads to Langfuse; cheapest paid cloud leads to Opik; evals first and hosted leads to Braintrust](/img/blog/langsmith-alternatives/04-decision.webp)

### Best LangSmith alternative for a startup

- **AcruxCore** if you want one self-hosted app for prompts, gateway, traces and evals, and the
  hosted plan is free to use.
- **Opik** if you want a paid cloud plan: $19 a month for up to 50 members.
- **Langfuse** if you want the largest open-source community and $29 a month for unlimited users.

### Best free LangSmith alternative

- **AcruxCore**, **MLflow** or **Arize Phoenix** to self-host without ClickHouse. AcruxCore runs
  on Postgres and Redis. MLflow and Phoenix each run as one Python process on SQLite. Phoenix's
  license forbids selling it as a hosted service.
- **Opik** for a free cloud plan that keeps data 60 days for up to 10 members.

### Self-hosted LangSmith alternatives for regulated teams

- **Langfuse** and **Opik** keep every trace on your servers. Both also need ClickHouse, an
  analytics database you must run and back up.
- **AcruxCore** keeps every trace on your servers on Postgres and Redis.
- **MLflow** keeps every trace on your servers on Postgres and an S3-compatible store.

### LangSmith alternatives for enterprises

- **Braintrust Enterprise** adds SAML single sign-on, custom roles and an SLA.
- **Langfuse Enterprise** adds audit logs, automatic user provisioning (SCIM) and an uptime SLA.

## FAQ

### Is LangSmith open source?

No. The LangSmith SDKs are MIT-licensed, but the platform has no public source code. The
self-hosted version ships as container images that need a license key.

### Is LangSmith free?

The Developer plan is free for 1 seat and 5,000 base traces a month, kept for 14 days. The Plus
plan costs $39 per seat a month. ([pricing](https://www.langchain.com/pricing))

### Can you self-host LangSmith?

Only on the Enterprise plan. Self-hosting is an add-on to that plan and needs a license key from
sales. It runs on Kubernetes with ClickHouse, PostgreSQL and Redis.

### Does LangSmith need LangChain?

Not for tracing. The `traceable` decorator and the OpenTelemetry endpoint work without LangChain.

### What is the best open-source LangSmith alternative?

Langfuse has the most GitHub stars of the open-source alternatives: 35,957. AcruxCore and MLflow add a gateway
to tracing, prompts and evals. Opik adds automatic prompt optimization.

## Related posts

- [Langfuse vs LangSmith](/blog/langfuse-vs-langsmith): one app run end to end on both.
- [9 LLM observability tools tested hands-on](/blog/hands-on-llm-ops-comparison): nine tools tested hands-on, with
  screenshots of each.
- [AcruxCore vs Langfuse vs LangSmith](/blog/acruxcore-vs-langfuse-vs-langsmith): the same app
  run on all three.
- [LangSmith hands-on walkthrough](/blog/langsmith-hands-on-walkthrough): every LangSmith screen,
  step by step.
- [8 best Langfuse alternatives for startups](/blog/langfuse-alternatives): the same comparison,
  starting from Langfuse.
- [Quickstart](/docs/getting-started/quickstart): sign up for AcruxCore and send a first trace.
- [Self-hosting AcruxCore](https://github.com/AcruxCore/AcruxCore#-self-hosting): the
  `docker compose` setup.
