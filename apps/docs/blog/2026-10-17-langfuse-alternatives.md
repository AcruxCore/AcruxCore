---
title: "7 best Langfuse alternatives for startups: self-hosted, cheaper and open source (2026)"
description: "Seven Langfuse alternatives compared on self-host effort, license, price and enterprise-only features, including which are lighter to run than Langfuse."
title_meta: "7 Best Langfuse Alternatives for Startups (2026)"
slug: langfuse-alternatives
date: 2026-10-17
authors: [acrux]
tags: [llmops-comparison, llm-tracing, prompt-management]
image: /img/blog/langfuse-alternatives/01-header.webp
keywords: [langfuse alternatives, alternatives to langfuse, best langfuse alternatives, best langfuse alternatives for startups, self-hosted langfuse alternatives, cheaper alternatives to langfuse, langfuse competitors, open source langfuse alternatives]
last_update:
  date: 2026-11-02
---

![Langfuse alternatives in a grid, each with what it is best for, coloured by license: MLflow, OpenLIT, Laminar and Opik open source, Arize Phoenix source-available, LangSmith and Braintrust closed source, and AcruxCore (ours) open source](/img/blog/langfuse-alternatives/01-header.webp)

This post compares seven alternatives to Langfuse on self-hosting effort, license, price and the
features that need an enterprise plan. For each Langfuse alternative, it lists what the tool adds,
what it lacks, and what changes when you move from Langfuse to it.

We build AcruxCore, one of the tools in this post. We do not rank it.

<!-- truncate -->

**The short answer**

- **Self-hosted without ClickHouse:** MLflow and Arize Phoenix. Each runs as one Python process on
  SQLite. In our self-hosting test, Phoenix used 0.47 GiB of memory at idle and MLflow 2.33 GiB,
  against 2.60 GiB for Langfuse.
- **Cheapest paid cloud:** Opik, at $19 a month.
- **A gateway, prompts, traces and evals in one open-source tool:** MLflow.
- **Built for LangChain apps:** LangSmith.
- **Not ranked:** AcruxCore (ours), described in [About AcruxCore](#about-acruxcore).

## Langfuse alternatives: feature comparison

**License, hosting and price**

| Tool | License | Data stores to self-host | Hosted free plan | Cheapest paid plan | Data kept on the paid plan |
|---|---|---|---|---|---|
| **Langfuse** | MIT core; enterprise (`ee/`) folders commercial | 4: Postgres, ClickHouse, Redis, S3 | Hobby: 50,000 units, 2 users, 30 days | Core: $29 a month, unlimited users | 90 days |
| MLflow | Apache-2.0 | 1: SQLite (Postgres and S3 for production) | None outside Databricks | Through Databricks | You decide |
| OpenLIT | Apache-2.0; Enterprise Edition commercial | 3: ClickHouse, SQLite, NATS | No hosted plan yet | No public price | You decide |
| Laminar | Apache-2.0 | 3: Postgres, ClickHouse, Quickwit | 1 GB, 1 seat, 7 days | Starter: $30 a month, unlimited seats | 30 days |
| Opik | Apache-2.0 | 5: MySQL, Redis, ClickHouse, ZooKeeper, MinIO | 25,000 spans a month, 10 members, 60 days | Pro: $19 a month, 50 members | 60 days |
| Arize Phoenix | Elastic License 2.0 | 1: SQLite or Postgres | Arize AX Free: 25,000 spans, 15 days | Arize AX Pro: $50 a month | 30 days |
| LangSmith | Closed source | Enterprise plan only | Developer: 5,000 traces, 1 seat, 14 days | Plus: $39 per seat a month | 14 days |
| Braintrust | Closed source | Enterprise plan only | 1 GB, unlimited users, 14 days | Pro: $249 a month | 30 days |
| AcruxCore (ours) | Apache-2.0 | 2: Postgres, Redis | Free; span content kept 90 days | None; the hosted platform is free to use | Not applicable |

**Features**

| Tool | Prompt versions | Gateway (your model calls pass through it) | Evals on datasets | Evals on live traffic | MCP server | Status in 2026 |
|---|---|---|---|---|---|---|
| **Langfuse** | Yes | No | Yes | Yes | Yes: prompts, traces, datasets, scores | Active; owned by ClickHouse since January 2026 |
| MLflow | Yes | Yes | Yes | Yes | Yes: traces, judges | Active; a Linux Foundation project |
| OpenLIT | Yes | No | Programmatic evals in the SDK or CI | Yes | No: none in the docs | Active; hosted plan announced, not launched |
| Laminar | No | No | Yes | Signals (rules in plain English) | Yes: read-only traces | Active |
| Opik | Yes | Beta, for development and testing | Yes | Yes | Yes: prompts, traces | Active |
| Arize Phoenix | Yes | No | Yes | Yes | Yes: prompts, traces, experiment results | Active |
| LangSmith | Yes | Beta | Yes | Yes | Yes: prompts, traces, deployments, sandboxes | Active |
| Braintrust | Yes | Yes, hosted, in public preview | Yes | Yes | Yes: prompts, logs, evals | Active |
| AcruxCore (ours) | Yes | Yes | Yes | Yes | [Yes](https://docs.acruxcore.com/docs/guides/connect-an-mcp-client): prompts (write and run), traces, experiments, tools | Active; public since August 2026 |

A **unit** on Langfuse is one trace, one step inside a trace, or one score. A **span** is one
step inside a trace. "Data stores" counts databases, caches, queues and file stores, not the
application containers. **Closed source** means the vendor publishes no server code. An **MCP
server** lets a coding assistant, such as Claude Code or Cursor, work with the platform's data.

Plans and prices as read on each vendor's pricing page on 17 October 2026. The Langfuse,
LangSmith, Opik, Laminar, Arize, Braintrust and OpenLIT pages were read again on
2 November 2026.

![Two columns. No ClickHouse: MLflow on SQLite, Arize Phoenix on SQLite or Postgres, AcruxCore on Postgres and Redis. Runs ClickHouse: Langfuse, Opik, Laminar and OpenLIT, each with its other data stores](/img/blog/langfuse-alternatives/03-selfhost.webp)

## Why look for alternatives to Langfuse?

- **Self-hosting runs four data stores.** A Langfuse install runs Postgres, ClickHouse, Redis
  and S3-compatible storage, plus a web and a worker container. Langfuse's docs describe
  ClickHouse as the "high-performance OLAP database which stores traces, observations, and
  scores". A column store such as ClickHouse keeps queries fast over millions of spans. In our
  self-hosting test, it also held 0.88 GiB of Langfuse's 2.60 GiB of idle memory.
- **Some features need an enterprise license, even self-hosted.** Organization-level roles are
  free. Project-level roles, audit logs, data retention controls, automatic user provisioning
  (SCIM), protected prompt labels and server-side masking are in the enterprise (`ee/`) folders.
- **Langfuse has no gateway.** Langfuse records model calls but does not send them to the
  provider. The Langfuse docs pair it with the LiteLLM proxy, which sits between your app and the
  providers and sends its logs to Langfuse.
- **Every step is billed.** Each step and each score inside a trace counts as one unit. The Hobby
  plan stops at 50,000 units with no overage, and Core charges $8 per 100,000 units over the
  included 100,000.
- **ClickHouse owns Langfuse.** ClickHouse acquired Langfuse in January 2026. The Langfuse core
  stays MIT, and Langfuse Cloud stays a product separate from ClickHouse Cloud.

![Five reasons teams look past Langfuse: four data stores, features behind an enterprise license, no gateway, every step billed, and a new owner, ClickHouse](/img/blog/langfuse-alternatives/02-why.webp)

Sources: Langfuse [license](https://github.com/langfuse/langfuse/blob/main/LICENSE),
[compose file](https://github.com/langfuse/langfuse/blob/main/docker-compose.yml),
[self-hosting](https://langfuse.com/self-hosting),
[self-host pricing](https://langfuse.com/pricing-self-host),
[cloud pricing](https://langfuse.com/pricing),
[LiteLLM page](https://langfuse.com/integrations/gateways/litellm),
[acquisition](https://clickhouse.com/blog/clickhouse-acquires-langfuse-open-source-llm-observability);
our [self-hosting measurements](/blog/self-hosting-llm-observability).

## How we picked

- **The tool does Langfuse's core jobs:** tracing, and at least one of prompts or evals.
- **The tool is active today.** Each tool had a release or a commit in October 2026.
- **The price is public**, or the tool is free to self-host.
- **Vendor facts come from the vendor:** the pricing page, the docs, the license file or the
  repository's compose file, read on 17 October 2026. The MCP servers, except OpenLIT's,
  were checked on 18 October 2026. We do not use other comparison lists as sources.
- **Measured facts come from our own runs.** Each one says "in our test" and links the post
  with the method. Memory figures come from one self-hosting test in October 2026, with every
  tool on the same machine and the same 1,000 traces.
- **AcruxCore is not ranked.** It has its own section after the ranked tools.

## Self-hosted Langfuse alternatives

These four tools use a license approved by the Open Source Initiative, and each one is free to
self-host.

### 1. MLflow

MLflow vs Langfuse: MLflow runs tracing, a prompt registry, judges and a gateway in one
Apache-2.0 server, so moving to it also replaces the LiteLLM proxy that Langfuse's docs pair
with Langfuse.

**Best for:** teams that already run MLflow for classic machine learning.

| | MLflow | Langfuse |
|---|---|---|
| License | Apache-2.0, Linux Foundation | MIT core; enterprise (`ee/`) folders commercial |
| Self-host | `pip install mlflow` and `mlflow server` on SQLite; Postgres and S3 storage for production | Postgres, ClickHouse, Redis, S3, web, worker |
| Cheapest paid plan | No public price; the managed version comes with Databricks | Core: $29 a month |
| Gateway | Yes | No |

**What changes when you move from Langfuse**

- You drop ClickHouse. MLflow can run as one Python process with a SQLite file, with no Docker.
- User permissions and workspaces are in the open-source version. On self-hosted Langfuse,
  project-level roles need the enterprise license.
- The gateway splits traffic by weight, falls back to another model, and rejects calls over a
  USD budget.
- The same server holds your training runs and model registry.
- MLflow's [MCP server](https://mlflow.org/docs/latest/genai/mcp/) reads traces and runs judges
  on them. The MLflow docs call the MCP server experimental.

**In our tests**

- The official compose setup ran 3 containers and used 2.33 GiB of memory at idle. Most of that
  was fifteen Python processes in the MLflow server, the default count.
- In our August 2026 test, a trace showed tokens and latency but no cost. Cost appeared only on
  the usage dashboard.
- Linking a trace to its prompt version needed an explicit `link_prompt_versions_to_trace()`
  call. Langfuse makes that link when you pass the prompt object to the model call.

**Limits of MLflow**

- MLflow has no hosted plan of its own. The managed version needs a Databricks workspace.
- Judges that score live traces need a gateway endpoint set up first.

Our comparison: [AcruxCore vs MLflow](/blog/acruxcore-vs-mlflow).

Sources: [license](https://raw.githubusercontent.com/mlflow/mlflow/master/LICENSE.txt),
[GenAI docs](https://mlflow.org/docs/latest/genai/),
[self-hosting](https://mlflow.org/docs/latest/self-hosting/),
[compose file](https://raw.githubusercontent.com/mlflow/mlflow/master/docker-compose/docker-compose.yml),
[managed MLflow](https://www.databricks.com/product/managed-mlflow);
our [self-hosting measurements](/blog/self-hosting-llm-observability) and
[MLflow test](/blog/acruxcore-vs-mlflow).

### 2. OpenLIT

OpenLIT vs Langfuse: OpenLIT is built on OpenTelemetry from the start. Like Langfuse, it stores
traces in ClickHouse, but it needs no Postgres, Redis or S3.

**Best for:** teams that already run OpenTelemetry or Grafana and also want GPU metrics.

| | OpenLIT | Langfuse |
|---|---|---|
| License | Apache-2.0; Enterprise Edition commercial | MIT core; enterprise (`ee/`) folders commercial |
| Self-host | ClickHouse, NATS and one app container with a SQLite file | Postgres, ClickHouse, Redis, S3, web, worker |
| Cheapest paid plan | No hosted plan yet; Enterprise has no public price | Core: $29 a month |
| Gateway | No | No |

**What changes when you move from Langfuse**

- The SDK sends standard OpenTelemetry data, so you can also export it to Grafana, Datadog or
  any OTLP backend.
- Evals run as LLM judges on live traces, or as programmatic evals in the SDK or in CI.
- OpenLIT Vault stores your provider keys, and your code fetches the keys at run time.
- A separate collector reports GPU metrics for NVIDIA, AMD and Intel cards.
- The SDKs cover Python, TypeScript and Go.

**Limits of OpenLIT**

- Roles, audit logs and alerts need the Enterprise Edition.
- OpenLIT Cloud has a waitlist only, so today you must run OpenLIT yourself.
- The docs describe no MCP server. Langfuse has one.
- We have not tested OpenLIT ourselves.

Sources: [license](https://github.com/openlit/openlit/blob/main/LICENSE),
[compose file](https://github.com/openlit/openlit/blob/main/docker-compose.yml),
[evaluations](https://docs.openlit.io/latest/openlit/evaluations/overview),
[docs](https://docs.openlit.io), [pricing](https://openlit.io/pricing).

### 3. Laminar

Laminar vs Langfuse: Laminar is open-source tracing built for agents, with SQL over your traces.
It has no prompt management, so a Langfuse user who versions prompts there needs another tool for
that job.

**Best for:** teams that run agents with many steps, or agents that use a browser.

| | Laminar | Langfuse |
|---|---|---|
| License | Apache-2.0; Signals and alerts need a license key when self-hosted | MIT core; enterprise (`ee/`) folders commercial |
| Self-host | Postgres, ClickHouse, Quickwit, frontend, app server | Postgres, ClickHouse, Redis, S3, web, worker |
| Cheapest paid plan | Starter: $30 a month, 3 GB, unlimited seats, 30 days | Core: $29 a month, 100,000 units, 90 days |
| Gateway | No | No |

**What changes when you move from Langfuse**

- Billing is by gigabyte of trace data, not by the number of steps. An agent with many steps
  per trace pays per unit on Langfuse.
- Laminar replays a browser agent's session as video, next to the matching steps of the trace.
- You can query traces, spans and metrics with SQL.
- Signals are rules written in plain English, such as "agent is stuck in a loop". Laminar
  checks every trace against these rules.
- Laminar's [MCP server](https://laminar.sh/docs/platform/mcp) gives a coding assistant read-only
  access to traces, and the assistant can query them with SQL.

**In our tests**

- The official compose setup ran 5 containers and used 1.11 GiB of memory at idle. The first
  boot took 4.8 minutes.
- In our September 2026 test, editing a playground overwrote its row, so a prompt kept no
  version history.

**Limits of Laminar**

- Laminar has no prompt management.
- Laminar's free plan keeps data 7 days and allows 1 seat. Langfuse Hobby keeps 30 days for
  2 users.

Our comparison: [AcruxCore vs Laminar](/blog/acruxcore-vs-laminar).

Sources: [repository](https://github.com/lmnr-ai/lmnr),
[compose file](https://github.com/lmnr-ai/lmnr/blob/main/docker-compose.yml),
[pricing](https://laminar.sh/pricing);
our [self-hosting measurements](/blog/self-hosting-llm-observability).

### 4. Opik

Opik vs Langfuse: Opik has the only paid cloud plan here that costs less than Langfuse Core, and
the whole Opik platform is Apache-2.0, with no enterprise folder.

**Best for:** teams that want open-source evals and automatic prompt optimization.

| | Opik | Langfuse |
|---|---|---|
| License | Apache-2.0 | MIT core; enterprise (`ee/`) folders commercial |
| Self-host | MySQL, Redis, ClickHouse, ZooKeeper, MinIO, three app services | Postgres, ClickHouse, Redis, S3, web, worker |
| Cheapest paid plan | Pro: $19 a month, 100,000 spans, up to 50 members, 60 days | Core: $29 a month, 100,000 units, 90 days |
| Gateway | Beta, for development and testing | No |

**What changes when you move from Langfuse**

- The paid cloud plan costs $10 a month less, and keeps data 60 days against Langfuse Core's
  90.
- Opik's free cloud plan keeps data 60 days for up to 10 members. Langfuse Hobby keeps 30 days
  for 2 users.
- Opik ships an optimizer package that rewrites prompts and agents for you, with six
  optimization algorithms. Langfuse has no prompt optimizer.
- Opik has guardrails for PII, topics and prompt injection.
- Opik's [MCP server](https://www.comet.com/docs/opik/mcp-server) reads traces and saves new prompt
  versions.

**In our tests**

- The official compose setup ran 8 containers and used 3.69 GiB of memory at idle, the most of
  the seven stacks we measured. After 1,000 traces it held 4.54 GiB.

**Limits of Opik**

- The self-hosted version has no user management.
- A self-hosted install runs five data stores, one more than Langfuse.

Our comparison: [AcruxCore vs Opik](/blog/acruxcore-vs-opik).

Sources: [README and license](https://github.com/comet-ml/opik/blob/main/README.md),
[pricing](https://www.comet.com/site/pricing/),
[self-hosting](https://www.comet.com/docs/opik/self-host/overview),
[compose file](https://github.com/comet-ml/opik/blob/main/deployment/docker-compose/docker-compose.yaml),
[gateway](https://www.comet.com/docs/opik/integrations/opik-llm-gateway),
[optimizer](https://github.com/comet-ml/opik/blob/main/sdks/opik_optimizer/README.md);
our [self-hosting measurements](/blog/self-hosting-llm-observability).

## Source-available: Arize Phoenix

### 5. Arize Phoenix

Phoenix vs Langfuse: Phoenix replaces Langfuse's four data stores with one container, and
self-hosted Phoenix has no feature limits. Its license, the Elastic License 2.0, is not
approved by the Open Source Initiative.

**Best for:** engineers who want free self-hosted tracing and evals built on OpenTelemetry.

| | Arize Phoenix | Langfuse |
|---|---|---|
| License | Elastic License 2.0 | MIT core; enterprise (`ee/`) folders commercial |
| Self-host | One container, SQLite or Postgres | Postgres, ClickHouse, Redis, S3, web, worker |
| Cheapest paid plan | Arize AX Pro: $50 a month, 50,000 spans, unlimited users, 30 days | Core: $29 a month, 100,000 units, 90 days |
| Gateway | No | No |

**What changes when you move from Langfuse**

- Self-hosted Phoenix includes OAuth2, LDAP and role-based access, with no license fee. On
  self-hosted Langfuse, project-level roles need the enterprise license.
- The Elastic License forbids selling Phoenix to others as a hosted service. Running Phoenix for
  your own team is allowed.
- Tracing uses OpenInference, Arize's OpenTelemetry conventions.
- Phoenix's [MCP server](https://github.com/Arize-ai/phoenix/tree/main/js/packages/phoenix-mcp/src)
  creates prompts, tags prompt versions and reads traces.

**In our tests**

- The official compose setup ran 2 containers and used 0.47 GiB of memory at idle, against
  2.60 GiB for Langfuse.
- In our August 2026 test, a dataset built from a trace could not drive an experiment against a
  templated prompt until we remapped its fields.

**Limits of Phoenix**

- The hosted plans are small: 25,000 spans on Free and 50,000 on Pro. Langfuse Core includes
  100,000 units.

Our comparison: [AcruxCore vs Phoenix](/blog/acruxcore-vs-phoenix).

Sources: [license](https://github.com/Arize-ai/phoenix/blob/main/LICENSE),
[self-hosting](https://arize.com/docs/phoenix/self-hosting),
[compose file](https://github.com/Arize-ai/phoenix/blob/main/docker-compose.yml),
[pricing](https://arize.com/pricing);
our [self-hosting measurements](/blog/self-hosting-llm-observability) and
[Phoenix test](/blog/acruxcore-vs-phoenix).

## Closed-source alternatives

LangSmith and Braintrust publish no server code. Self-hosting either one needs an enterprise
contract, so moving to either from a self-hosted Langfuse means moving your traces to a hosted
service.

### 6. LangSmith

LangSmith vs Langfuse: LangSmith is the LangChain team's hosted platform. Langfuse is open source
and free to self-host. We ran one app on both, so this section uses our own results.

**Best for:** apps built on LangChain or LangGraph.

| | LangSmith | Langfuse |
|---|---|---|
| License | Closed source; SDKs MIT | MIT core; enterprise (`ee/`) folders commercial |
| Self-host | Enterprise plan only | Free |
| Cheapest paid plan | Plus: $39 per seat a month, 10,000 traces, 14 days | Core: $29 a month, unlimited users, 90 days |
| Gateway | Beta | No |

**What changes when you move from Langfuse**

- LangSmith has a gateway in beta, with spend and rate limits.
- LangSmith has SDKs for Go and Java as well as Python and TypeScript.
- Startups with venture funding can get up to $10,000 in credits.
- LangSmith's [MCP server](https://docs.langchain.com/langsmith/langsmith-remote-mcp) pushes and
  tags prompts, reads traces, and works with deployments and sandboxes.

**In our tests**

- The comparison of two experiment runs filtered to the examples whose score changed in one
  click. Langfuse could not hide the unchanged examples.
- A plain Python function, asked to run 4 examples at a time, ran 4 at a time on LangSmith
  (94.3 s) and one at a time on Langfuse (472.1 s).
- A prompt read with no tag returned the newest commit, drafts included. Langfuse returned the
  `production` version, so code moved from Langfuse must ask for `name:production`.
- Pushing a prompt from code needed the `langchain-core` package.
- For 100,000 traces a month and 3 people, LangSmith Plus cost $567 and Langfuse Core $98.36.

**Limits of LangSmith**

- LangSmith keeps base traces 14 days. Keeping traces 180 days costs an extra fee that the
  pricing page does not state.
- Plus costs $39 per seat, so three people pay $117 a month before they pay for extra traces.

We compared both on one app in [Langfuse vs LangSmith](/blog/langfuse-vs-langsmith). For more
options starting from LangSmith, see [7 LangSmith alternatives](/blog/langsmith-alternatives).

Sources: [pricing](https://www.langchain.com/pricing),
[billing](https://docs.langchain.com/langsmith/billing),
[gateway](https://docs.langchain.com/langsmith/llm-gateway),
[self-hosting](https://docs.langchain.com/langsmith/architectural-overview).

### 7. Braintrust

Braintrust vs Langfuse: Braintrust is a closed-source, hosted platform built around evals, with a
flat price and unlimited users. Its cheapest paid plan costs $220 a month more than Langfuse Core.

**Best for:** teams whose main work is evals and experiments.

| | Braintrust | Langfuse |
|---|---|---|
| License | Closed source; SDKs Apache-2.0 | MIT core; enterprise (`ee/`) folders commercial |
| Self-host | Enterprise only; your data stays in your cloud, Braintrust hosts the UI | Free |
| Cheapest paid plan | Pro: $249 a month, 5 GB, unlimited users, 30 days | Core: $29 a month, 90 days |
| Gateway | Yes, hosted, in public preview | No |

**What changes when you move from Langfuse**

- Loop is an agent inside Braintrust. It reads your logs and experiments, then edits prompts,
  scorers and datasets after you approve.
- The gateway caches responses for up to 7 days and falls back to another provider on errors.
- Braintrust gives Pro free for 6 to 12 months to startups that qualify.
- Braintrust's [MCP server](https://www.braintrust.dev/docs/reference/mcp) creates prompts, queries
  logs in SQL and runs evals.

**In our tests**

- In our September 2026 test, a SQL sandbox queried experiments, logs and datasets.
- Loop proposed a fix to a failing query as a red and green diff, and asked before applying it.
  Its rewrite dropped the `FROM` clause, and the new query also failed.
- The self-hosted data plane started in about 25 seconds, but a Starter account had no setting
  to connect it.

**Limits of Braintrust**

- Braintrust's free plan keeps data 14 days. Langfuse Hobby keeps 30 days.
- Self-hosting any part of Braintrust needs an Enterprise contract.

Our comparison: [AcruxCore vs Braintrust](/blog/acruxcore-vs-braintrust). For more options
starting from Braintrust, see [9 Braintrust alternatives](/blog/braintrust-alternatives).

Sources: [pricing](https://www.braintrust.dev/pricing),
[self-hosting](https://www.braintrust.dev/docs/admin/self-hosting),
[gateway](https://www.braintrust.dev/docs/deploy/gateway),
[Loop](https://www.braintrust.dev/docs/guides/loop).

## About AcruxCore

AcruxCore vs Langfuse: both are open source and cover prompts, tracing and evals. AcruxCore also
has a gateway. A self-hosted AcruxCore needs only Postgres and Redis.

**Best for:** small teams that want prompts, a gateway, traces and evals in one self-hosted app.

| | AcruxCore | Langfuse |
|---|---|---|
| License | Apache-2.0, no enterprise folder | MIT core; enterprise (`ee/`) folders commercial |
| Self-host | Postgres, Redis, API, worker, web | Postgres, ClickHouse, Redis, S3, web, worker |
| Cheapest paid plan | None; the hosted platform is free to use | Core: $29 a month, 100,000 units |
| Gateway | Yes | No |

**Where AcruxCore differs**

- The gateway is part of the product. It holds your provider keys, caches responses, falls back
  to a second model, and stops calls at a spend budget or a rate limit.
- You define the tools a model can call and keep versions of them. AcruxCore runs a tool when
  your code calls its API.
- Roles and the audit log are free in every AcruxCore install. Langfuse has free
  organization-level roles and keeps the audit log and project-level roles for its enterprise
  license.
- A prompt run can rewrite the prompt for you and score the new version against a dataset.
- The [MCP server](https://docs.acruxcore.com/docs/guides/connect-an-mcp-client) lets a coding assistant run a stored prompt through the gateway and
  read the trace that the run produced.

**Limits of AcruxCore**

- The AcruxCore repository went public in August 2026 and had 11 GitHub stars on 25 October 2026.
  Langfuse had 36,448.
- AcruxCore has no SAML or OIDC single sign-on. Sign-in is email or Google.
- AcruxCore deletes span content after 90 days by default. One setting covers the whole install,
  not each project.
- The SDKs are Python and TypeScript only.
- AcruxCore has no review queue. Langfuse has one.

Our hands-on comparison is [AcruxCore vs Langfuse](/blog/acruxcore-vs-langfuse). The
[comparison page](https://acruxcore.com/compare) puts AcruxCore next to Langfuse and five other
self-hostable platforms, feature by feature.

Sources: [license](https://github.com/AcruxCore/AcruxCore/blob/main/LICENSE),
[compose file](https://github.com/AcruxCore/AcruxCore/blob/main/docker-compose.local.yml),
[pricing](https://acruxcore.com/pricing).

## Tools other lists still recommend

Older lists of Langfuse alternatives still include these six tools. Their status, checked on
17 October 2026 and, for Helicone and Portkey, again on 2 November 2026:

- **Lunary** is no longer open source. Its server repository returns 404 on GitHub, and Docker
  self-hosting needs the Enterprise Edition.
  ([source](https://docs.lunary.ai/more/self-hosting/docker.md))
- **Agenta** now calls itself "the open-source workspace for your agents". Its current docs no
  longer cover prompts, evaluation or observability; those pages are in an archived v1.0 section.
  ([source](https://agenta.ai/docs/))
- **Helicone** was acquired by Mintlify in March 2026, and Mintlify said Helicone would run in
  maintenance mode, with security updates, bug fixes and new models. On 2 November 2026, a banner
  on Helicone's website reads "Helicone is no longer part of Mintlify. Details to come soon."
  ([Mintlify](https://www.mintlify.com/blog/mintlify-acquires-helicone),
  [Helicone](https://www.helicone.ai/))
- **Portkey** was acquired by Palo Alto Networks in May 2026. The open-source gateway repository
  has had no merged code since 25 May 2026.
  ([source](https://www.paloaltonetworks.com/company/press/2026/palo-alto-networks-completes-acquisition-of-portkey-to-secure-ai-agents))
- **Galileo** was acquired by Cisco and is now sold as Splunk Agent Observability.
  ([source](https://www.splunk.com/en_us/about-splunk/acquisitions/galileo.html))
- **Traceloop** announced in March 2026 that it is joining ServiceNow. Its OpenLLMetry library
  stays open source and active. ([source](https://traceloop.com/blog/traceloop-is-joining-servicenow))

We left out Pydantic Logfire: its platform is closed source, and self-hosting it needs an
enterprise contract.
([source](https://pydantic.dev/pricing))

## Which Langfuse alternative should you pick?

> **Key point:** Pick by the reason you are leaving Langfuse. MLflow and Arize Phoenix drop
> ClickHouse, Opik costs less in the cloud, LangSmith fits LangChain apps, and Laminar fits
> browser agents.

### Best Langfuse alternative for a startup

- **Opik** if you want a paid cloud plan: $19 a month for up to 50 members.
- **MLflow** if you already use MLflow and want a gateway in the same server.

### Cheaper alternatives to Langfuse

| Tool | Cheapest paid plan | What it includes | Data kept |
|---|---|---|---|
| Langfuse | $29 a month | 100,000 units, unlimited users | 90 days |
| Opik | $19 a month | 100,000 spans, up to 50 members | 60 days |
| AcruxCore (ours) | Free | Every feature | 90 days of span content |

### Langfuse alternatives that cost more

| Tool | Cheapest paid plan | What it includes | Data kept |
|---|---|---|---|
| Laminar | $30 a month | 3 GB, unlimited seats | 30 days |
| LangSmith | $39 per seat a month | 10,000 traces | 14 days |
| Arize AX Pro | $50 a month | 50,000 spans, unlimited users | 30 days |
| Braintrust | $249 a month | 5 GB, 50,000 scores, unlimited users | 30 days |

### Best free Langfuse alternative

- **MLflow** or **Arize Phoenix** to self-host without ClickHouse. Each runs as one Python process
  on SQLite. Phoenix's license forbids selling it as a hosted service.
- **Opik** for a free cloud plan that keeps data 60 days for up to 10 members.

### For AI agent observability

- **Laminar** replays browser-agent sessions and checks every trace against plain-English rules.
- **Opik** and **Phoenix** trace OpenAI Agents SDK runs and score them with LLM judges.

### If your app is built on LangChain

- **LangSmith** is built by the LangChain team. LangChain and LangGraph runs send traces to
  LangSmith once `LANGSMITH_TRACING` and `LANGSMITH_API_KEY` are set.

### Langfuse alternatives for enterprises

- **LangSmith Enterprise** and **Braintrust Enterprise** include self-hosting, single sign-on
  and an uptime guarantee (SLA).
- **Langfuse Enterprise** costs $2,499 a month on the cloud. It adds audit logs, automatic user
  provisioning (SCIM) and an uptime SLA.

AcruxCore (ours) is not ranked. It is free to self-host on Postgres and Redis, and its hosted
platform is free to use; see [About AcruxCore](#about-acruxcore).

## FAQ

### Is Langfuse Apache 2.0?

No. The Langfuse core is under the MIT license. The `ee/` folders are under a separate
commercial license and need a Langfuse Enterprise agreement.
([license](https://github.com/langfuse/langfuse/blob/main/LICENSE))

### Is Langfuse free?

The self-hosted core is free. The Hobby cloud plan is free for 50,000 units a month, 2 users and
30 days of data. ([pricing](https://langfuse.com/pricing))

### What does self-hosting Langfuse take?

A web container, a worker container, Postgres, ClickHouse, Redis or Valkey, and S3-compatible
storage. In our self-hosting test, the stack used 2.60 GiB of memory at idle.
([self-hosting](https://langfuse.com/self-hosting))

### Who owns Langfuse now?

ClickHouse acquired Langfuse in January 2026. The core stays MIT-licensed.
([announcement](https://clickhouse.com/blog/clickhouse-acquires-langfuse-open-source-llm-observability))

### Does Langfuse have an LLM gateway?

No. Langfuse records model calls but does not send them to the provider. The Langfuse docs pair
it with the LiteLLM proxy. MLflow includes a gateway, LangSmith and Opik have one in beta, and
Braintrust has a hosted one in preview.

## Related posts

- [AcruxCore vs Langfuse](/blog/acruxcore-vs-langfuse): one scope-check app run on both,
  with prompt versions, a diff view and live-traffic latency.
- [Langfuse vs LangSmith](/blog/langfuse-vs-langsmith): one app run end to end on both.
- [10 LLM observability tools tested hands-on](/blog/hands-on-llm-ops-comparison): ten tools tested hands-on, with
  screenshots of each.
- [AcruxCore vs Langfuse vs LangSmith](/blog/acruxcore-vs-langfuse-vs-langsmith): the same app
  run on all three.
- [Langfuse hands-on walkthrough](/blog/langfuse-hands-on-walkthrough): every Langfuse screen,
  step by step.
- [7 LangSmith alternatives for startups](/blog/langsmith-alternatives): the same comparison,
  starting from LangSmith.
- [Self-hosting LLM observability tools: seven measured, six open source](/blog/self-hosting-llm-observability):
  memory, disk and trace storage for Langfuse, AcruxCore and five more stacks on one machine.
- [Self-hosting AcruxCore](https://github.com/AcruxCore/AcruxCore#-self-hosting): the
  `docker compose` setup.
