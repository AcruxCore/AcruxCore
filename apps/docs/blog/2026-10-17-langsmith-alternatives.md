---
title: "7 LangSmith alternatives for startups: open source, self-hosted and cheaper (2026)"
description: "Seven LangSmith alternatives compared on license, free self-hosting, per-seat price and trace retention: which are open source, and which fit a startup."
title_meta: "LangSmith Alternatives: 7 Tools, 4 Open Source (2026)"
slug: langsmith-alternatives
date: 2026-10-17
authors: [acrux]
tags: [llmops-comparison, llm-tracing, prompt-management]
image: /img/blog/langsmith-alternatives/01-header.webp
keywords: [langsmith alternatives, alternatives to langsmith, best langsmith alternatives, langsmith competitors, open source langsmith alternative, self-hosted langsmith alternatives, best langsmith alternatives for startups, best free langsmith alternative]
last_update:
  date: 2026-11-02
---

![LangSmith alternatives in a grid, each with what it is best for, coloured by license: Langfuse, Opik, MLflow and Laminar open source, Arize Phoenix source-available, Braintrust and W&B Weave closed source, and AcruxCore (ours) open source](/img/blog/langsmith-alternatives/01-header.webp)

This post compares seven LangSmith alternatives on license, self-hosting, price and features.
For each alternative to LangSmith, it lists what the tool adds, what it lacks, and how it
changes the per-seat price and the 14-day trace retention that push teams off LangSmith. A
section at the end shows how to move your traces.

We build AcruxCore, one of the tools in this post. We do not rank it.

<!-- truncate -->

**The short answer**

- **Open source and free to self-host:** Langfuse, Laminar, MLflow and Opik.
- **One flat price for the whole team:** Langfuse Core at $29 a month, or Opik Pro at $19 for up
  to 50 members.
- **Tracing, prompts, evals and a gateway in one open-source tool:** MLflow.
- **Evals first, hosted for you:** Braintrust.
- **Not ranked:** AcruxCore (ours), described in [About AcruxCore](#about-acruxcore).

## LangSmith competitors at a glance

**License and hosting**

| Tool | License | Self-host | Hosted free plan | Cheapest paid plan | Data kept on the paid plan |
|---|---|---|---|---|---|
| **LangSmith** | Closed source | Enterprise plan only | Developer: 5,000 traces, 1 seat, 14 days | Plus: $39 per seat a month | 14 days |
| Langfuse | MIT core; enterprise (`ee/`) folders commercial | Free | Hobby: 50,000 units, 2 users, 30 days | Core: $29 a month, unlimited users | 90 days |
| Opik | Apache-2.0 | Free | 25,000 spans a month, 10 members, 60 days | Pro: $19 a month, 50 members | 60 days |
| MLflow | Apache-2.0 | Free | None outside Databricks | Through Databricks | You decide |
| Laminar | Apache-2.0 | Free | 1 GB, 1 seat, 7 days | Starter: $30 a month, unlimited seats | 30 days |
| Arize Phoenix | Elastic License 2.0 | Free | Arize AX Free: 25,000 spans, 15 days | Arize AX Pro: $50 a month | 30 days |
| Braintrust | Closed source | Enterprise plan only | 1 GB, unlimited users, 14 days | Pro: $249 a month | 30 days |
| W&B Weave | SDK Apache-2.0; server not published | Needs W&B Self-Managed and a Weave license | 1 GB a month, 5 seats | Pro: from $60 a month, 10 seats | Not published |
| AcruxCore (ours) | Apache-2.0 | Free | Free; span content kept 90 days | None; the hosted platform is free to use | Not applicable |

**Features**

| Tool | Prompt versions | Gateway (your model calls pass through it) | Evals on datasets | Evals on live traffic | MCP server | Status in 2026 |
|---|---|---|---|---|---|---|
| **LangSmith** | Yes | Beta | Yes | Yes | Yes: prompts, traces, deployments, sandboxes | Active |
| Langfuse | Yes | No | Yes | Yes | Yes: prompts, traces, datasets, scores | Active; owned by ClickHouse since January 2026 |
| Opik | Yes | Beta, for development and testing | Yes | Yes | Yes: prompts, traces | Active |
| MLflow | Yes | Yes | Yes | Yes | Yes: traces, judges | Active; a Linux Foundation project |
| Laminar | No | No | Yes | Signals (rules in plain English) | Yes: read-only traces | Active |
| Arize Phoenix | Yes | No | Yes | Yes | Yes: prompts, traces, experiment results | Active |
| Braintrust | Yes | Yes, hosted, in public preview | Yes | Yes | Yes: prompts, logs, evals | Active |
| W&B Weave | Partial | No | Yes | Yes | Yes, mostly read-only: traces, evals, reports | Active; W&B is owned by CoreWeave |
| AcruxCore (ours) | Yes | Yes | Yes | Yes | [Yes](https://docs.acruxcore.com/docs/guides/connect-an-mcp-client): prompts (write and run), traces, experiments, tools | Active; public since August 2026 |

A **unit** on Langfuse is one trace, one step inside a trace, or one score. Opik, Phoenix and Braintrust bill by span (one step of a trace) or by gigabyte. That makes their free plans hard to set against LangSmith's 5,000 traces. **Closed source**:
the vendor does not publish the server code. **MCP server**: a connection that lets a coding
assistant such as Cursor or Claude Code read or change the platform's data.

We read each vendor's pricing page on 17 October 2026. The LangSmith,
Langfuse, Opik, Laminar, Arize and Braintrust pages were read again on 2 November 2026.

![Three columns. Free with no ClickHouse: MLflow, Arize Phoenix, AcruxCore. Free but runs ClickHouse: Langfuse, Opik, Laminar. Needs a paid license: LangSmith, Braintrust, W&B Weave](/img/blog/langsmith-alternatives/03-selfhost.webp)

## Why teams look for a LangSmith alternative

- **Every seat costs money.** The Plus plan costs $39 per seat a month. Three people pay $117 a
  month before they pay for extra traces.
- **Traces are kept 14 days.** Base traces on Free and Plus are deleted after 14 days. Extended
  traces are kept 180 days, for 0.0025 LSU ($0.0025) a trace more, per the pricing page.
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
- **Still maintained:** every tool shipped a release or a commit in October 2026.
- **A public price,** or free self-hosting.
- **Sources:** pricing pages, docs, license files and compose files from each vendor, read on
  17 October 2026, and the MCP servers on 18 October 2026. Other comparison lists are not used
  as sources.
- **Our own runs:** a measured fact is marked "in our test" and its section links the post
  that describes the method. The memory figures are from one October 2026 run, with each tool
  alone on the same machine and fed the same 1,000 traces.
- **AcruxCore is left out of the ranking** and described in its own section at the end.

## Open-source LangSmith alternatives (free to self-host)

These four tools use a license approved by the Open Source Initiative. You can run every one of
them on your own servers without paying, which LangSmith allows only on Enterprise.

### 1. Langfuse

Langfuse vs LangSmith: Langfuse charges one flat price for the whole team and keeps data 90 days
on its cheapest paid plan. The results below come from one app we ran on both platforms.

**Best for:** teams that want the open-source tool with the largest community for tracing,
prompts and evals.

| | Langfuse | LangSmith |
|---|---|---|
| License | MIT core; enterprise (`ee/`) folders under a commercial license | Closed source |
| Self-host | Free: web, worker, Postgres, ClickHouse, Redis, S3 storage | Enterprise plan only |
| Cheapest paid plan | Core: $29 a month, 100,000 units, unlimited users, 90 days | Plus: $39 per seat a month, 10,000 traces, 14 days |
| Gateway | No | Beta |

**What changes when you move from LangSmith**

- The price no longer grows with seats. It grows with units instead: each trace, step and score
  counts as one.
- Langfuse has the largest community here: 36,448 GitHub stars on 25 October 2026.
- Datasets, experiments, LLM-as-judge on live traces and review queues are all in the free
  self-hosted version.
- Langfuse's [MCP server](https://langfuse.com/docs/api-and-data-platform/features/mcp-server)
  creates prompts, moves prompt labels, and reads traces, datasets and scores.

**In our tests**

- For 100,000 traces a month and 3 people, Langfuse Core cost $98.36 and LangSmith Plus $567.
- Our app needed 11 lines of tracing and prompt-fetching code on Langfuse, against 18 on
  LangSmith.
- A prompt read with no label returned the `production` version. LangSmith returned the newest
  commit, drafts included.
- A plain Python function, asked to run 4 examples at a time, ran one at a time on Langfuse
  (472.1 s) and 4 at a time on LangSmith (94.3 s). An `async` function ran 4 at a time on
  Langfuse.
- Langfuse's comparison of two runs could not hide the examples whose score stayed the same.
  LangSmith filtered to the changed examples in one click.
- The self-hosted stack used 2.60 GiB of memory at idle.

**Limits of Langfuse**

- There is no gateway in Langfuse; its docs put LiteLLM in front for that job.
- A self-hosted install runs four data stores: Postgres, ClickHouse, Redis and S3.
- Organization-level roles are free. Audit logs, project-level roles and retention controls
  need an enterprise license, even when you self-host.

We compared both tools on one app in
[Langfuse vs LangSmith](/blog/langfuse-vs-langsmith).

Sources: [license](https://github.com/langfuse/langfuse/blob/main/LICENSE),
[pricing](https://langfuse.com/pricing),
[self-host pricing](https://langfuse.com/pricing-self-host),
[compose file](https://github.com/langfuse/langfuse/blob/main/docker-compose.yml),
[ClickHouse acquisition](https://clickhouse.com/blog/clickhouse-acquires-langfuse-open-source-llm-observability);
our [self-hosting measurements](/blog/self-hosting-llm-observability).

### 2. Opik

Opik vs LangSmith: Opik Pro costs $19 a month for up to 50 members, less than one LangSmith Plus
seat, and keeps data 60 days.

**Best for:** teams that want open-source evals and a tool that rewrites prompts for them.

| | Opik | LangSmith |
|---|---|---|
| License | Apache-2.0 | Closed source |
| Self-host | Free: MySQL, Redis, ClickHouse, ZooKeeper, MinIO, three app services | Enterprise plan only |
| Cheapest paid plan | Pro: $19 a month, 100,000 spans, up to 50 members, 60 days | Plus: $39 per seat a month |
| Gateway | Beta, for development and testing | Beta |

**What changes when you move from LangSmith**

- Opik's free cloud plan allows 10 members and keeps data 60 days. LangSmith's free plan allows
  1 seat and keeps base traces 14 days.
- A separate optimizer package, with six algorithms, rewrites your prompts and agents.
- Guardrails check for PII, off-limit topics and prompt injection.
- A coding assistant can read traces and save prompt versions through Opik's
  [MCP server](https://www.comet.com/docs/opik/mcp-server).

**In our tests**

- Self-hosted from the official compose file, Opik ran 8 containers and idled at 3.69 GiB of
  memory. No other stack in that test used more.

**Limits of Opik**

- Self-hosted Opik has no user management, so it has no per-user access.
- A self-hosted install runs five data stores: MySQL, Redis, ClickHouse, ZooKeeper and MinIO.
- The Opik docs describe the Opik gateway as beta, for development and testing.

Our comparison: [AcruxCore vs Opik](/blog/acruxcore-vs-opik).

Sources: [README and license](https://github.com/comet-ml/opik/blob/main/README.md),
[pricing](https://www.comet.com/site/pricing/),
[self-hosting](https://www.comet.com/docs/opik/self-host/overview),
[compose file](https://github.com/comet-ml/opik/blob/main/deployment/docker-compose/docker-compose.yaml),
[gateway](https://www.comet.com/docs/opik/integrations/opik-llm-gateway),
[optimizer](https://github.com/comet-ml/opik/blob/main/sdks/opik_optimizer/README.md);
our [self-hosting measurements](/blog/self-hosting-llm-observability).

### 3. MLflow

MLflow vs LangSmith: MLflow is free to self-host with no license key, and it has a gateway,
where LangSmith's gateway is in beta.

**Best for:** teams whose classic ML work already lives in MLflow.

| | MLflow | LangSmith |
|---|---|---|
| License | Apache-2.0, Linux Foundation | Closed source |
| Self-host | Free: `pip install mlflow` and `mlflow server` on SQLite; Postgres and S3 storage for production | Enterprise plan only |
| Cheapest paid plan | No public price; the managed version comes with Databricks | Plus: $39 per seat a month |
| Gateway | Yes | Beta |

**What changes when you move from LangSmith**

- You keep the traces as long as you want. Retention is your own setting, not a paid upgrade.
- MLflow can run as one Python process with a SQLite file, with no Docker.
- Its gateway can split traffic by weight and fall back to a second model. It refuses calls
  once a USD budget is spent.
- Judges can score live traces with no code change.
- Review queues assign traces to people. The MLflow docs call them experimental, added in
  MLflow 3.14.0, and some input types work fully only on Databricks.
- An [MCP server](https://mlflow.org/docs/latest/genai/mcp/), marked experimental in the docs,
  lets a coding assistant read traces and run judges.

**In our tests**

- Self-hosted from the official compose file, MLflow ran 3 containers and idled at 2.33 GiB.
- In August 2026, a single trace showed tokens and latency, and cost appeared only on the usage
  dashboard.

**Limits of MLflow**

- There is no hosted MLflow plan from MLflow itself. Managed MLflow comes with a Databricks
  workspace.

Our comparison: [AcruxCore vs MLflow](/blog/acruxcore-vs-mlflow).

Sources: [license](https://raw.githubusercontent.com/mlflow/mlflow/master/LICENSE.txt),
[GenAI docs](https://mlflow.org/docs/latest/genai/),
[review queues](https://mlflow.org/docs/latest/genai/assessments/review-queues/),
[self-hosting](https://mlflow.org/docs/latest/self-hosting/),
[compose file](https://raw.githubusercontent.com/mlflow/mlflow/master/docker-compose/docker-compose.yml),
[managed MLflow](https://www.databricks.com/product/managed-mlflow);
our [self-hosting measurements](/blog/self-hosting-llm-observability) and
[MLflow test](/blog/acruxcore-vs-mlflow).

### 4. Laminar

Laminar vs LangSmith: Laminar Starter costs $30 a month with unlimited seats and keeps data
30 days. It has no prompt management, so prompts kept in LangSmith need another home.

**Best for:** agents with long chains of steps, and agents that drive a browser.

| | Laminar | LangSmith |
|---|---|---|
| License | Apache-2.0; Signals and alerts need a license key when self-hosted | Closed source |
| Self-host | Free: Postgres, ClickHouse, Quickwit, frontend, app server | Enterprise plan only |
| Cheapest paid plan | Starter: $30 a month, 3 GB, unlimited seats, 30 days | Plus: $39 per seat a month, 14 days |
| Gateway | No | Beta |

**What changes when you move from LangSmith**

- Laminar bills by gigabyte of trace data, not by seat or by trace.
- A browser agent's session plays back as video beside the trace steps it belongs to.
- Traces, spans and metrics answer SQL queries, and Laminar's
  [MCP server](https://laminar.sh/docs/platform/mcp) lets a coding assistant run those queries.
- You write Signals in plain English, for example "agent is stuck in a loop", and Laminar
  tests each trace against them.

**In our tests**

- Self-hosted from the official compose file, Laminar ran 5 containers and idled at 1.11 GiB.
  Its first start took 4.8 minutes.

**Limits of Laminar**

- There is no prompt registry, so prompt versions need a separate tool.
- Laminar's free cloud plan keeps data 7 days and allows 1 seat.

Our comparison: [AcruxCore vs Laminar](/blog/acruxcore-vs-laminar).

Sources: [repository](https://github.com/lmnr-ai/lmnr),
[compose file](https://github.com/lmnr-ai/lmnr/blob/main/docker-compose.yml),
[pricing](https://laminar.sh/pricing);
our [self-hosting measurements](/blog/self-hosting-llm-observability).

## Source-available: Arize Phoenix

### 5. Arize Phoenix

Phoenix vs LangSmith: Phoenix is free to self-host with no feature limits, in one container,
while LangSmith self-hosts only on Enterprise and Kubernetes. Its license, the Elastic License
2.0, is not approved by the Open Source Initiative.

**Best for:** engineers who want OpenTelemetry tracing and evals on their own server at no cost.

| | Arize Phoenix | LangSmith |
|---|---|---|
| License | Elastic License 2.0 | Closed source |
| Self-host | Free: one container, SQLite or Postgres | Enterprise plan only |
| Cheapest paid plan | Arize AX Pro: $50 a month, 50,000 spans, unlimited users, 30 days | Plus: $39 per seat a month |
| Gateway | No | Beta |

**What changes when you move from LangSmith**

- Self-hosting takes one container, or `pip install arize-phoenix` and `phoenix serve`, with
  SQLite.
- Tracing uses OpenInference, Arize's OpenTelemetry conventions, so any OpenTelemetry language
  can send spans.
- Prompts have versions and tags, and the playground replays a traced model call.
- You may run Phoenix for your own team. The Elastic License does not allow you to sell it to
  others as a hosted service.
- Through Phoenix's [MCP server](https://github.com/Arize-ai/phoenix/tree/main/js/packages/phoenix-mcp/src),
  a coding assistant can create and tag prompts and read traces.

**In our tests**

- Self-hosted from the official compose file, Phoenix ran 2 containers and idled at 0.47 GiB,
  the lowest of the ranked tools.

**Limits of Phoenix**

- Arize AX Free includes 25,000 spans and Pro 50,000, which is small for a busy app.
- On the hosted Arize AX plans, single sign-on and audit logs need Enterprise.

Our comparison: [AcruxCore vs Phoenix](/blog/acruxcore-vs-phoenix).

Sources: [license](https://github.com/Arize-ai/phoenix/blob/main/LICENSE),
[self-hosting](https://arize.com/docs/phoenix/self-hosting),
[compose file](https://github.com/Arize-ai/phoenix/blob/main/docker-compose.yml),
[pricing](https://arize.com/pricing);
our [self-hosting measurements](/blog/self-hosting-llm-observability).

## Hosted, closed-source alternatives

Braintrust and W&B Weave publish no server code, like LangSmith. Self-hosting either one needs an
enterprise contract, so these two change the price model, not the hosting model.

### 6. Braintrust

Braintrust vs LangSmith: both are closed source and hosted. Braintrust charges a flat price with
unlimited users, and LangSmith charges per seat, so Braintrust Pro costs less than LangSmith Plus
from seven seats, before trace charges.

**Best for:** teams that spend most of their time on evals and experiments.

| | Braintrust | LangSmith |
|---|---|---|
| License | Closed source; SDKs Apache-2.0 | Closed source; SDKs MIT |
| Self-host | Enterprise only; your data stays in your cloud, Braintrust hosts the UI | Enterprise only |
| Cheapest paid plan | Pro: $249 a month, 5 GB, unlimited users, 30 days | Plus: $39 per seat a month |
| Gateway | Yes, hosted, in public preview | Beta |

**What changes when you move from LangSmith**

- Pro keeps data 30 days. LangSmith Plus keeps base traces 14 days.
- Loop, an agent built into Braintrust, reads logs and experiments and, once you approve,
  changes prompts, scorers and datasets.
- On errors, the gateway falls back to another provider. It can cache responses for up to
  7 days.
- Startup programs: Braintrust offers 6 to 12 months of free Pro to startups that qualify, and
  LangSmith offers up to $10,000 in credits to startups with venture funding.

**In our tests**

- In our September 2026 test, Loop proposed a fix to a failing query as a red and green diff,
  and asked before applying it. Its rewrite dropped the `FROM` clause, and the new query also
  failed.
- The self-hosted data plane was healthy after about 25 seconds. A Starter account offered no
  setting to connect it, so it could not be used.

**Limits of Braintrust**

- Starter, the free plan, keeps data 14 days, the same as LangSmith's base traces.
- Prompt environments need Pro.
- The Braintrust gateway has no uptime guarantee (SLA) while it is in preview.

Our comparison: [AcruxCore vs Braintrust](/blog/acruxcore-vs-braintrust). If you are leaving
Braintrust instead, read [9 Braintrust alternatives](/blog/braintrust-alternatives).

Sources: [pricing](https://www.braintrust.dev/pricing),
[self-hosting](https://www.braintrust.dev/docs/admin/self-hosting),
[gateway](https://www.braintrust.dev/docs/deploy/gateway),
[Loop](https://www.braintrust.dev/docs/guides/loop).

### 7. W&B Weave

Weave vs LangSmith: Weave Pro starts at $60 a month for 10 seats, and it puts LLM traces and
evals next to Weights & Biases experiment tracking.

**Best for:** teams that already use Weights & Biases.

| | W&B Weave | LangSmith |
|---|---|---|
| License | SDK Apache-2.0; the trace server is not published | Closed source |
| Self-host | Needs W&B Self-Managed, a Weave license from W&B support, Kubernetes and a ClickHouse cluster | Enterprise plan only |
| Cheapest paid plan | Pro: from $60 a month, 10 seats, 1.5 GB of traces a month | Plus: $39 per seat a month |
| Gateway | No | Beta |

**What changes when you move from LangSmith**

- One subscription covers W&B experiment tracking and Weave traces.
- Monitors run LLM-judge checks, such as hallucination, on every production trace.
- The playground compares models side by side, using provider keys stored as team secrets.
- Weave's [MCP server](https://github.com/wandb/wandb-mcp-server) reads traces, evaluation results,
  runs and reports.

**Limits of Weave**

- Pro includes 1.5 GB of traces a month.
- The pricing page does not state how long traces are kept.
- We have not tested Weave ourselves.

Sources: [pricing](https://wandb.ai/site/pricing),
[README](https://github.com/wandb/weave/blob/master/README.md),
[self-managed Weave](https://docs.coreweave.com/weave/guides/platform/weave-self-managed.md),
[monitors](https://docs.coreweave.com/weave/guides/evaluation/monitors.md),
[CoreWeave acquisition](https://coreweave.com/blog/coreweave-completes-acquisition-of-weights-biases).

## About AcruxCore

AcruxCore vs LangSmith: both cover prompts, tracing and evals. AcruxCore is Apache-2.0 and free
to self-host, and its gateway sends your model calls to the provider.

**Best for:** a small team that wants one self-hosted app for prompts, gateway, traces and evals.

| | AcruxCore | LangSmith |
|---|---|---|
| License | Apache-2.0, no enterprise folder | Closed source |
| Self-host | Free: Postgres, Redis, API, worker, web | Enterprise plan only |
| Cheapest paid plan | None; the hosted platform is free to use | Plus: $39 per seat a month |
| Gateway | Yes | Beta |

**Where AcruxCore differs**

- The gateway comes with the product: it keeps your provider keys, caches responses, falls
  back to a second model, and stops calls at a spend budget or a rate limit.
- Tools that a model can call are defined and versioned in AcruxCore, which runs one when your
  code calls its API.
- Every AcruxCore install has roles and the audit log at no cost. Custom roles on LangSmith
  need Enterprise.
- Self-hosting needs two data stores, Postgres and Redis, with no ClickHouse.
- Through the [MCP server](https://docs.acruxcore.com/docs/guides/connect-an-mcp-client), a coding assistant runs a stored prompt through the gateway and
  then reads the trace of that run.

**Limits of AcruxCore**

- The repository has been public since August 2026, and it had 11 GitHub stars on
  25 October 2026.
- Sign-in is email or Google only, with no SAML or OIDC single sign-on.
- There is no review queue in AcruxCore, and LangSmith has one.
- The gateway supports OpenAI, Anthropic, Gemini and OpenAI-compatible APIs. The SDKs are Python
  and TypeScript only. LangSmith also has Go and Java SDKs.

Our longer comparison is [AcruxCore vs LangSmith](/blog/acrux-core-vs-langsmith). The
[comparison page](https://acruxcore.com/compare) puts AcruxCore next to six self-hostable
platforms, feature by feature.

Sources: [license](https://github.com/AcruxCore/AcruxCore/blob/main/LICENSE),
[compose file](https://github.com/AcruxCore/AcruxCore/blob/main/docker-compose.local.yml),
[pricing](https://acruxcore.com/pricing).

## Moving your traces off LangSmith

Changing the trace destination sends new traces only. Traces already in LangSmith stay there, and
base traces are deleted after 14 days, so export anything you want to keep first.

- **If your app sends OpenTelemetry to LangSmith,** it sets
  `OTEL_EXPORTER_OTLP_ENDPOINT=https://api.smith.langchain.com/otel` and an `x-api-key` header.
  Point the exporter at the new tool's OTLP endpoint and change the header. For Langfuse Cloud
  EU, the endpoint is `https://cloud.langfuse.com/api/public/otel`, with Basic auth built from
  your public and secret keys.
- **If your app uses the LangSmith SDK,** swap the wrappers. On Langfuse, `@traceable` becomes
  `@observe` and `wrap_openai` becomes the `langfuse.openai` client. For the other tools, use
  their own SDK or their OpenTelemetry endpoint.
- **Prompts and datasets do not move with the traces.** The LangSmith Python client reads them
  with `pull_prompt_commit` and `list_examples`, so a script can copy them into the new tool.
  LangSmith stores a prompt in LangChain's JSON format, so the script must turn it into role and
  content messages.
- **Code that asks for `name:production`** maps to a `production` label on Langfuse. A Langfuse
  read with no label returns that version.

In our self-hosting test, Langfuse, Opik, MLflow, Laminar and Phoenix each received the same
1,000 traces over OTLP, the OpenTelemetry wire format.

Sources: LangSmith [OpenTelemetry](https://docs.langchain.com/langsmith/trace-with-opentelemetry),
Langfuse [OpenTelemetry](https://langfuse.com/docs/opentelemetry/get-started),
[LangSmith Python client](https://github.com/langchain-ai/langsmith-sdk/blob/main/python/langsmith/client.py);
our [Langfuse vs LangSmith](/blog/langfuse-vs-langsmith) and
[self-hosting](/blog/self-hosting-llm-observability) tests.

## Tools other lists still recommend

Older lists of LangSmith alternatives still include these five tools. Their status, checked on
17 October 2026 and, for Helicone and Portkey, again on 2 November 2026:

- **Helicone** was acquired by Mintlify in March 2026, and Mintlify said Helicone would run in
  maintenance mode, with security updates, bug fixes and new models. On 2 November 2026, a banner
  on Helicone's website reads "Helicone is no longer part of Mintlify. Details to come soon."
  ([Mintlify](https://www.mintlify.com/blog/mintlify-acquires-helicone),
  [Helicone](https://www.helicone.ai/))
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

> **Key point:** Pick by what you pay for on LangSmith today. Langfuse and Opik replace per-seat
> pricing with a flat team price, MLflow and Arize Phoenix self-host for free without ClickHouse,
> and Braintrust keeps you hosted with unlimited users.

### Best LangSmith alternative for a startup

- **Opik** for the cheapest paid cloud: $19 a month, with room for 50 members.
- **Langfuse** if you want the largest open-source community and $29 a month for unlimited users.

### Best free LangSmith alternative

- **MLflow** or **Arize Phoenix**, if you will self-host and want no ClickHouse. Both can run as
  a single Python process with SQLite, and Phoenix's license bars reselling it as a service.
- **Opik**, if you want a free cloud plan: 10 members and 60 days of data.

### Self-hosted LangSmith alternatives for regulated teams

- **Langfuse** and **Opik** keep every trace on your servers. Both also need ClickHouse, an
  analytics database you must run and back up.
- **MLflow** keeps every trace on your servers on Postgres and an S3-compatible store.

### LangSmith alternatives for enterprises

- **Braintrust Enterprise** adds SAML single sign-on, custom roles and an SLA.
- **Langfuse Enterprise** adds audit logs, automatic user provisioning (SCIM) and an uptime SLA.

AcruxCore (ours) is not ranked. It keeps every trace on your servers on Postgres and Redis, and
its hosted platform is free to use; see [About AcruxCore](#about-acruxcore).

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
([OpenTelemetry](https://docs.langchain.com/langsmith/trace-with-opentelemetry))

### What is the best open-source LangSmith alternative?

Langfuse has the most GitHub stars of the open-source alternatives: 36,448 on 25 October 2026.
MLflow adds a gateway to tracing, prompts and evals. Opik adds automatic prompt optimization.

### How do you move traces off LangSmith?

Point your OpenTelemetry exporter, or your SDK, at the new tool. New traces go there, while old
traces stay in LangSmith until its retention deletes them, so export prompts and datasets first.

## Related posts

- [Langfuse vs LangSmith](/blog/langfuse-vs-langsmith): one app run end to end on both.
- [10 LLM observability tools tested hands-on](/blog/hands-on-llm-ops-comparison): ten tools tested hands-on, with
  screenshots of each.
- [AcruxCore vs Langfuse vs LangSmith](/blog/acruxcore-vs-langfuse-vs-langsmith): the same app
  run on all three.
- [LangSmith hands-on walkthrough](/blog/langsmith-hands-on-walkthrough): every LangSmith screen,
  step by step.
- [7 best Langfuse alternatives for startups](/blog/langfuse-alternatives): the same comparison,
  starting from Langfuse.
- [Quickstart](https://docs.acruxcore.com/docs/getting-started/quickstart): sign up for AcruxCore and send a first trace.
- [Self-hosting LLM observability tools: seven measured, six open source](/blog/self-hosting-llm-observability):
  memory, disk and trace storage for seven self-hosted stacks on one machine.
- [Self-hosting AcruxCore](https://github.com/AcruxCore/AcruxCore#-self-hosting): the
  `docker compose` setup.
