---
title: "8 best Langfuse alternatives for startups: self-hosted, cheaper and open source (2026)"
description: "Eight Langfuse alternatives compared on self-host effort, license, price and what sits behind an enterprise plan, including which ones are lighter to run than Langfuse."
title_meta: "8 Best Langfuse Alternatives for Startups (2026)"
slug: langfuse-alternatives
date: 2026-10-17
authors: [acrux]
tags: [llmops-comparison, llm-tracing, prompt-management]
image: /img/blog/langfuse-alternatives/01-header.webp
keywords: [langfuse alternatives, alternatives to langfuse, best langfuse alternatives, best langfuse alternatives for startups, self-hosted langfuse alternatives, cheaper alternatives to langfuse, langfuse competitors, open source langfuse alternatives]
---

![Eight Langfuse alternatives in a grid, each with what it is best for, coloured by license: AcruxCore, MLflow, OpenLIT, Laminar and Opik open source, Arize Phoenix source-available, LangSmith and Braintrust closed source](/img/blog/langfuse-alternatives/01-header.webp)

This post compares eight alternatives to Langfuse on self-hosting effort, license, price and the
features that need an enterprise plan. For each Langfuse alternative, it lists what the tool adds
and what it lacks.

<!-- truncate -->

**The short answer**

- **Self-hosted without ClickHouse:** AcruxCore runs on Postgres and Redis. MLflow and Arize
  Phoenix each run as one Python process on SQLite.
- **Cheapest paid cloud:** Opik, at $19 a month.
- **A gateway, prompts, traces and evals in one open-source tool:** AcruxCore or MLflow.
- **Built for LangChain apps:** LangSmith.

## Langfuse alternatives: feature comparison

**License, hosting and price**

| Tool | License | Data stores to self-host | Hosted free plan | Cheapest paid plan | Data kept on the paid plan |
|---|---|---|---|---|---|
| **Langfuse** | MIT core; enterprise (`ee/`) folders commercial | 4: Postgres, ClickHouse, Redis, S3 | Hobby: 50,000 units, 2 users, 30 days | Core: $29 a month, unlimited users | 90 days |
| AcruxCore | Apache-2.0 | 2: Postgres, Redis | Free; span content kept 90 days | None; the hosted plan is free | Not applicable |
| MLflow | Apache-2.0 | 1: SQLite (Postgres and S3 for production) | None outside Databricks | Through Databricks | You decide |
| OpenLIT | Apache-2.0; Enterprise Edition commercial | 2: ClickHouse, SQLite | No hosted plan yet | No public price | You decide |
| Laminar | Apache-2.0 | 3: Postgres, ClickHouse, Quickwit | 1 GB, 1 seat, 7 days | Starter: $30 a month, unlimited seats | 30 days |
| Opik | Apache-2.0 | 5: MySQL, Redis, ClickHouse, ZooKeeper, MinIO | 25,000 spans a month, 10 members, 60 days | Pro: $19 a month, 50 members | 60 days |
| Arize Phoenix | Elastic License 2.0 | 1: SQLite or Postgres | Arize AX Free: 25,000 spans, 15 days | Arize AX Pro: $50 a month | 30 days |
| LangSmith | Closed source | Enterprise plan only | Developer: 5,000 traces, 1 seat, 14 days | Plus: $39 per seat a month | 14 days |
| Braintrust | Closed source | Enterprise plan only | 1 GB, unlimited users, 14 days | Pro: $249 a month | 30 days |

**Features**

| Tool | Prompt versions | Gateway (your model calls pass through it) | Evals on datasets | Evals on live traffic | MCP server | Status in 2026 |
|---|---|---|---|---|---|---|
| **Langfuse** | Yes | No | Yes | Yes | Yes: prompts, traces, datasets, scores | Active; owned by ClickHouse since January 2026 |
| AcruxCore | Yes | Yes | Yes | Yes | [Yes](/docs/guides/connect-an-mcp-client): prompts (write and run), traces, experiments, tools | Active; public since August 2026 |
| MLflow | Yes | Yes | Yes | Yes | Yes: traces, judges | Active; a Linux Foundation project |
| OpenLIT | Yes | No | Not in the docs we read | Yes | Not checked | Active; hosted plan announced, not launched |
| Laminar | No | No | Yes | Signals (rules in plain English) | Yes: read-only traces | Active |
| Opik | Yes | Beta, for development and testing | Yes | Yes | Yes: prompts, traces | Active |
| Arize Phoenix | Yes | No | Yes | Yes | Yes: prompts, traces, experiment results | Active |
| LangSmith | Yes | Beta | Yes | Yes | Yes: prompts, traces, deployments, sandboxes | Active |
| Braintrust | Yes | Yes, hosted, in public preview | Yes | Yes | Yes: prompts, logs, evals | Active |

A **unit** on Langfuse is one trace, one step inside a trace, or one score. A **span** is one
step inside a trace. "Data stores" counts databases, caches, queues and file stores, not the
application containers. **Closed source** means the vendor publishes no server code. An **MCP
server** lets a coding assistant, such as Claude Code or Cursor, work with the platform's data.

If you want the self-hostable tools at a glance, the [comparison page](https://acruxcore.com/compare) puts AcruxCore
next to Langfuse and five other self-hostable platforms, feature by feature.

![Two columns. No ClickHouse: AcruxCore on Postgres and Redis, MLflow on SQLite, Arize Phoenix on SQLite or Postgres. Runs ClickHouse: Langfuse, Opik, Laminar and OpenLIT, each with its other data stores](/img/blog/langfuse-alternatives/03-selfhost.webp)

## Why look for alternatives to Langfuse?

- **Self-hosting runs four data stores.** A Langfuse install runs Postgres, ClickHouse, Redis
  and S3-compatible storage, plus a web and a worker container.
- **Some features need an enterprise license, even self-hosted.** Audit logs, project-level
  roles, data retention controls, automatic user provisioning (SCIM), protected prompt labels and
  server-side masking are in the enterprise (`ee/`) folders.
- **Langfuse has no gateway.** Langfuse records model calls but does not send them to the
  provider. The Langfuse docs use LiteLLM as the gateway in front of it.
- **Every step is billed.** Each step and each score inside a trace counts as one unit. The Hobby
  plan stops at 50,000 units with no overage, and Core charges $8 per 100,000 units over the
  included 100,000.
- **ClickHouse owns Langfuse.** ClickHouse acquired Langfuse in January 2026. The Langfuse core
  stays MIT, and Langfuse Cloud stays a product separate from ClickHouse Cloud.

![Five reasons teams look past Langfuse: four data stores, features behind an enterprise license, no gateway, every step billed, and a new owner, ClickHouse](/img/blog/langfuse-alternatives/02-why.webp)

Sources: Langfuse [license](https://github.com/langfuse/langfuse/blob/main/LICENSE),
[compose file](https://github.com/langfuse/langfuse/blob/main/docker-compose.yml),
[self-host pricing](https://langfuse.com/pricing-self-host),
[cloud pricing](https://langfuse.com/pricing),
[LiteLLM page](https://langfuse.com/docs/integrations/litellm/tracing),
[acquisition](https://clickhouse.com/blog/clickhouse-acquires-langfuse-open-source-llm-observability).

## How we picked

- **The tool does Langfuse's core jobs:** tracing, and at least one of prompts or evals.
- **The tool is active today.** Each tool had a release or a commit in October 2026.
- **The price is public**, or the tool is free to self-host.
- **Every fact comes from the vendor:** the pricing page, the docs, the license file or the
  repository's compose file, read on 17 October 2026. The MCP servers, except OpenLIT's,
  were checked on 18 October 2026. We do not use other comparison lists as sources.

## Self-hosted Langfuse alternatives

These five tools use a license approved by the Open Source Initiative, and each one is free to
self-host.

### 1. AcruxCore

AcruxCore vs Langfuse: both are open source and cover prompts, tracing and evals. AcruxCore also
has a gateway. A self-hosted AcruxCore needs only Postgres and Redis.

**Best for:** small teams that want prompts, a gateway, traces and evals in one self-hosted app.

| | AcruxCore | Langfuse |
|---|---|---|
| License | Apache-2.0, no enterprise folder | MIT core; enterprise (`ee/`) folders commercial |
| Self-host | Postgres, Redis, API, worker, web | Postgres, ClickHouse, Redis, S3, web, worker |
| Cheapest paid plan | None; the hosted plan is free to use | Core: $29 a month, 100,000 units |
| Gateway | Yes | No |

**Where AcruxCore differs**

- The gateway is part of the product. It holds your provider keys, caches responses, falls back
  to a second model, and stops calls at a spend budget or a rate limit.
- You define the tools a model can call and keep versions of them. AcruxCore runs a tool when
  your code calls its API.
- Roles and the audit log are free in every AcruxCore install. Langfuse keeps the audit log and
  project-level roles for its enterprise license.
- A prompt run can rewrite the prompt for you and score the new version against a dataset.
- The [MCP server](/docs/guides/connect-an-mcp-client) lets a coding assistant run a stored prompt through the gateway and
  read the trace that the run produced.

**Limits of AcruxCore**

- The AcruxCore repository went public in August 2026 and has 11 GitHub stars. Langfuse has
  35,957 stars.
- AcruxCore has no SAML or OIDC single sign-on. Sign-in is email or Google.
- AcruxCore deletes span content after 90 days by default. One setting covers the whole install,
  not each project.
- The SDKs are Python and TypeScript only.

Our hands-on comparison is [AcruxCore vs Langfuse](/blog/acruxcore-vs-langfuse).

Sources: [license](https://github.com/AcruxCore/AcruxCore/blob/main/LICENSE),
[compose file](https://github.com/AcruxCore/AcruxCore/blob/main/docker-compose.local.yml),
[pricing](https://acruxcore.com/pricing).

### 2. MLflow

MLflow vs Langfuse: MLflow is an Apache-2.0 ML platform with tracing, a prompt registry, judges
and a gateway in one server.

**Best for:** teams that already run MLflow for classic machine learning.

| | MLflow | Langfuse |
|---|---|---|
| License | Apache-2.0, Linux Foundation | MIT core; enterprise (`ee/`) folders commercial |
| Self-host | `pip install mlflow` and `mlflow server` on SQLite; Postgres and S3 storage for production | Postgres, ClickHouse, Redis, S3, web, worker |
| Cheapest paid plan | No public price; the managed version comes with Databricks | Core: $29 a month |
| Gateway | Yes | No |

**Where MLflow differs**

- MLflow can run as one Python process with a SQLite file, with no Docker.
- The gateway splits traffic by weight, falls back to another model, and rejects calls over a
  USD budget.
- User permissions and workspaces are in the open-source version, with no license key.
- The same server holds your training runs and model registry.
- MLflow's [MCP server](https://mlflow.org/docs/latest/genai/mcp/) reads traces and runs judges
  on them. The MLflow docs call the MCP server experimental.

**Limits of MLflow**

- MLflow has no hosted plan of its own. The managed version needs a Databricks workspace.
- Judges that score live traces need a gateway endpoint set up first.

Our comparison: [AcruxCore vs MLflow](/blog/acruxcore-vs-mlflow).

Sources: [license](https://raw.githubusercontent.com/mlflow/mlflow/master/LICENSE.txt),
[GenAI docs](https://mlflow.org/docs/latest/genai/),
[self-hosting](https://mlflow.org/docs/latest/self-hosting/),
[compose file](https://raw.githubusercontent.com/mlflow/mlflow/master/docker-compose/docker-compose.yml),
[managed MLflow](https://www.databricks.com/product/managed-mlflow).

### 3. OpenLIT

OpenLIT vs Langfuse: OpenLIT is built on OpenTelemetry from the start and self-hosts on
ClickHouse plus one app container.

**Best for:** teams that already run OpenTelemetry or Grafana and also want GPU metrics.

| | OpenLIT | Langfuse |
|---|---|---|
| License | Apache-2.0; Enterprise Edition commercial | MIT core; enterprise (`ee/`) folders commercial |
| Self-host | ClickHouse and one app container | Postgres, ClickHouse, Redis, S3, web, worker |
| Cheapest paid plan | No hosted plan yet; Enterprise has no public price | Core: $29 a month |
| Gateway | No | No |

**Where OpenLIT differs**

- The SDK sends standard OpenTelemetry data, so you can also export it to Grafana, Datadog or
  any OTLP backend.
- OpenLIT Vault stores your provider keys, and your code fetches the keys at run time.
- A separate collector reports GPU metrics for NVIDIA, AMD and Intel cards.
- The SDKs cover Python, TypeScript and Go.

**Limits of OpenLIT**

- Roles, audit logs and alerts need the Enterprise Edition.
- OpenLIT Cloud has a waitlist only, so today you must run OpenLIT yourself.

Sources: [license](https://github.com/openlit/openlit/blob/main/LICENSE),
[compose file](https://github.com/openlit/openlit/blob/main/docker-compose.yml),
[docs](https://docs.openlit.io), [pricing](https://openlit.io/pricing).

### 4. Laminar

Laminar vs Langfuse: Laminar is open-source tracing built for agents, with SQL over your traces
and no prompt management.

**Best for:** teams that run agents with many steps, or agents that use a browser.

| | Laminar | Langfuse |
|---|---|---|
| License | Apache-2.0; Signals and alerts need a license key when self-hosted | MIT core; enterprise (`ee/`) folders commercial |
| Self-host | Postgres, ClickHouse, Quickwit, frontend, app server | Postgres, ClickHouse, Redis, S3, web, worker |
| Cheapest paid plan | Starter: $30 a month, 3 GB, unlimited seats, 30 days | Core: $29 a month, 100,000 units, 90 days |
| Gateway | No | No |

**Where Laminar differs**

- Laminar replays a browser agent's session as video, next to the matching steps of the trace.
- You can query traces, spans and metrics with SQL.
- Signals are rules written in plain English, such as "agent is stuck in a loop". Laminar
  checks every trace against these rules.
- Laminar bills by gigabyte of trace data, not by the number of steps.
- Laminar's [MCP server](https://laminar.sh/docs/platform/mcp) gives a coding assistant read-only
  access to traces, and the assistant can query them with SQL.

**Limits of Laminar**

- Laminar has no prompt management, so you need another tool to version prompts.
- Laminar's free plan keeps data 7 days and allows 1 seat.

Our comparison: [AcruxCore vs Laminar](/blog/acruxcore-vs-laminar).

Sources: [repository](https://github.com/lmnr-ai/lmnr),
[compose file](https://github.com/lmnr-ai/lmnr/blob/main/docker-compose.yml),
[pricing](https://laminar.sh/pricing).

### 5. Opik

Opik vs Langfuse: the whole Opik platform is Apache-2.0, and Opik has the cheapest paid cloud
plan here.

**Best for:** teams that want open-source evals and automatic prompt optimization.

| | Opik | Langfuse |
|---|---|---|
| License | Apache-2.0 | MIT core; enterprise (`ee/`) folders commercial |
| Self-host | MySQL, Redis, ClickHouse, ZooKeeper, MinIO, three app services | Postgres, ClickHouse, Redis, S3, web, worker |
| Cheapest paid plan | Pro: $19 a month, 100,000 spans, up to 50 members, 60 days | Core: $29 a month, 100,000 units, 90 days |
| Gateway | Beta, for development and testing | No |

**Where Opik differs**

- Opik ships an optimizer package that rewrites prompts and agents for you, with six
  optimization algorithms.
- Opik has guardrails for PII, topics and prompt injection.
- Opik's free cloud plan keeps data 60 days for up to 10 members. Langfuse Hobby keeps 30 days for
  2 users.
- Opik's [MCP server](https://www.comet.com/docs/opik/mcp-server) reads traces and saves new prompt
  versions.

**Limits of Opik**

- The self-hosted version has no user management.
- A self-hosted install runs five data stores, one more than Langfuse.

Our comparison: [AcruxCore vs Opik](/blog/acruxcore-vs-opik).

Sources: [README and license](https://github.com/comet-ml/opik/blob/main/README.md),
[pricing](https://www.comet.com/site/pricing/),
[self-hosting](https://www.comet.com/docs/opik/self-host/overview),
[compose file](https://github.com/comet-ml/opik/blob/main/deployment/docker-compose/docker-compose.yaml),
[gateway](https://www.comet.com/docs/opik/integrations/opik-llm-gateway),
[optimizer](https://github.com/comet-ml/opik/blob/main/sdks/opik_optimizer/README.md).

## Source-available: Arize Phoenix

### 6. Arize Phoenix

Phoenix vs Langfuse: Phoenix self-hosts in one container with no feature limits. Its license,
the Elastic License 2.0, is not approved by the Open Source Initiative.

**Best for:** engineers who want free self-hosted tracing and evals built on OpenTelemetry.

| | Arize Phoenix | Langfuse |
|---|---|---|
| License | Elastic License 2.0 | MIT core; enterprise (`ee/`) folders commercial |
| Self-host | One container, SQLite or Postgres | Postgres, ClickHouse, Redis, S3, web, worker |
| Cheapest paid plan | Arize AX Pro: $50 a month, 50,000 spans, unlimited users, 30 days | Core: $29 a month, 100,000 units, 90 days |
| Gateway | No | No |

**Where Phoenix differs**

- Self-hosted Phoenix has no feature limits and no license fee.
- The Elastic License forbids selling Phoenix to others as a hosted service. Running Phoenix for
  your own team is allowed.
- Self-hosted Phoenix includes OAuth2, LDAP and role-based access.
- Tracing uses OpenInference, Arize's OpenTelemetry conventions.
- Phoenix's [MCP server](https://github.com/Arize-ai/phoenix/tree/main/js/packages/phoenix-mcp/src)
  creates prompts, tags prompt versions and reads traces.

**Limits of Phoenix**

- The hosted plans are small: 25,000 spans on Free and 50,000 on Pro.

Our comparison: [AcruxCore vs Phoenix](/blog/acruxcore-vs-phoenix).

Sources: [license](https://github.com/Arize-ai/phoenix/blob/main/LICENSE),
[self-hosting](https://arize.com/docs/phoenix/self-hosting),
[compose file](https://github.com/Arize-ai/phoenix/blob/main/docker-compose.yml),
[pricing](https://arize.com/pricing).

## Closed-source alternatives

LangSmith and Braintrust publish no server code. Self-hosting either one needs an enterprise
contract.

### 7. LangSmith

LangSmith vs Langfuse: LangSmith is the LangChain team's hosted platform. Langfuse is open source
and free to self-host.

**Best for:** apps built on LangChain or LangGraph.

| | LangSmith | Langfuse |
|---|---|---|
| License | Closed source; SDKs MIT | MIT core; enterprise (`ee/`) folders commercial |
| Self-host | Enterprise plan only | Free |
| Cheapest paid plan | Plus: $39 per seat a month, 10,000 traces, 14 days | Core: $29 a month, unlimited users, 90 days |
| Gateway | Beta | No |

**Where LangSmith differs**

- LangSmith has a gateway in beta, with spend and rate limits.
- LangSmith has SDKs for Go and Java as well as Python and TypeScript.
- Startups with venture funding can get up to $10,000 in credits.
- LangSmith's [MCP server](https://docs.langchain.com/langsmith/langsmith-remote-mcp) pushes and
  tags prompts, reads traces, and works with deployments and sandboxes.

**Limits of LangSmith**

- LangSmith keeps base traces 14 days. Keeping traces 180 days costs extra.
- Plus costs $39 per seat, so three people pay $117 a month before they pay for extra traces.

We compared both on one app in [Langfuse vs LangSmith](/blog/langfuse-vs-langsmith). For more
options starting from LangSmith, see [8 LangSmith alternatives](/blog/langsmith-alternatives).

Sources: [pricing](https://www.langchain.com/pricing),
[billing](https://docs.langchain.com/langsmith/billing),
[gateway](https://docs.langchain.com/langsmith/llm-gateway),
[self-hosting](https://docs.langchain.com/langsmith/architectural-overview).

### 8. Braintrust

Braintrust vs Langfuse: Braintrust is a closed-source, hosted platform built around evals, with a flat
price and unlimited users.

**Best for:** teams whose main work is evals and experiments.

| | Braintrust | Langfuse |
|---|---|---|
| License | Closed source; SDKs Apache-2.0 | MIT core; enterprise (`ee/`) folders commercial |
| Self-host | Enterprise only; your data stays in your cloud, Braintrust hosts the UI | Free |
| Cheapest paid plan | Pro: $249 a month, 5 GB, unlimited users, 30 days | Core: $29 a month, 90 days |
| Gateway | Yes, hosted, in public preview | No |

**Where Braintrust differs**

- Loop is an agent inside Braintrust. It reads your logs and experiments, then edits prompts,
  scorers and datasets after you approve.
- The gateway caches responses for up to 7 days and falls back to another provider on errors.
- Braintrust gives Pro free for 6 to 12 months to startups that qualify.
- Braintrust's [MCP server](https://www.braintrust.dev/docs/reference/mcp) creates prompts, queries
  logs in SQL and runs evals.

**Limits of Braintrust**

- Braintrust's free plan keeps data 14 days.
- Self-hosting any part of Braintrust needs an Enterprise contract.

Our comparison: [AcruxCore vs Braintrust](/blog/acruxcore-vs-braintrust).

Sources: [pricing](https://www.braintrust.dev/pricing),
[self-hosting](https://www.braintrust.dev/docs/admin/self-hosting),
[gateway](https://www.braintrust.dev/docs/deploy/gateway),
[Loop](https://www.braintrust.dev/docs/guides/loop).

## Tools other lists still recommend

Older lists of Langfuse alternatives still include these six tools. Their status on
17 October 2026:

- **Lunary** is no longer open source. Its server repository returns 404 on GitHub, and Docker
  self-hosting needs the Enterprise Edition.
  ([source](https://docs.lunary.ai/more/self-hosting/docker.md))
- **Agenta** now calls itself "the open-source workspace for your agents". Its current docs no
  longer cover prompts, evaluation or observability; those pages are in an archived v1.0 section.
  ([source](https://agenta.ai/docs/))
- **Helicone** was acquired by Mintlify in March 2026. The service runs in maintenance mode: it
  gets security fixes, bug fixes and new models, but no new features.
  ([source](https://www.helicone.ai/blog/joining-mintlify))
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

Start at the top and stop at the first question you answer yes to.

![Decision flow: self-host without ClickHouse leads to AcruxCore, MLflow or Phoenix; otherwise cheapest paid cloud leads to Opik; built on LangChain leads to LangSmith; browser agents lead to Laminar](/img/blog/langfuse-alternatives/04-decision.webp)

### Best Langfuse alternative for a startup

- **AcruxCore** if you want one self-hosted app for prompts, gateway, traces and evals, and the
  hosted plan is free to use.
- **Opik** if you want a paid cloud plan: $19 a month for up to 50 members.
- **MLflow** if you already use MLflow and want a gateway in the same server.

### Cheaper alternatives to Langfuse

| Tool | Cheapest paid plan | What it includes | Data kept |
|---|---|---|---|
| Langfuse | $29 a month | 100,000 units, unlimited users | 90 days |
| Opik | $19 a month | 100,000 spans, up to 50 members | 60 days |
| Laminar | $30 a month | 3 GB, unlimited seats | 30 days |
| Arize AX Pro | $50 a month | 50,000 spans, unlimited users | 30 days |
| LangSmith | $39 per seat a month | 10,000 traces | 14 days |
| Braintrust | $249 a month | 5 GB, 50,000 scores, unlimited users | 30 days |
| AcruxCore | Free | Every feature | 90 days of span content |

### Best free Langfuse alternative

- **AcruxCore**, **MLflow** or **Arize Phoenix** to self-host without ClickHouse. AcruxCore runs
  on Postgres and Redis. MLflow and Phoenix each run as one Python process on SQLite. Phoenix's
  license forbids selling it as a hosted service.
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
storage. ([self-hosting](https://langfuse.com/self-hosting))

### Who owns Langfuse now?

ClickHouse acquired Langfuse in January 2026. The core stays MIT-licensed.
([announcement](https://clickhouse.com/blog/clickhouse-acquires-langfuse-open-source-llm-observability))

### Does Langfuse have an LLM gateway?

No. Langfuse records model calls but does not send them to the provider. The Langfuse docs use
LiteLLM as the gateway. AcruxCore and MLflow include a gateway. LangSmith and Opik have one in
beta, and Braintrust has a hosted one in preview.

## Related posts

- [AcruxCore vs Langfuse](/blog/acruxcore-vs-langfuse): the same prompt built and run on both,
  with screenshots and a latency benchmark.
- [Langfuse vs LangSmith](/blog/langfuse-vs-langsmith): one app run end to end on both.
- [9 LLM observability tools tested hands-on](/blog/hands-on-llm-ops-comparison): nine tools tested hands-on, with
  screenshots of each.
- [AcruxCore vs Langfuse vs LangSmith](/blog/acruxcore-vs-langfuse-vs-langsmith): the same app
  run on all three.
- [Langfuse hands-on walkthrough](/blog/langfuse-hands-on-walkthrough): every Langfuse screen,
  step by step.
- [8 LangSmith alternatives for startups](/blog/langsmith-alternatives): the same comparison,
  starting from LangSmith.
- [Self-hosting LLM observability: seven open-source tools measured](/blog/self-hosting-llm-observability):
  memory, disk and trace storage for Langfuse, AcruxCore and five more stacks on one machine.
- [Self-hosting AcruxCore](https://github.com/AcruxCore/AcruxCore#-self-hosting): the
  `docker compose` setup.
