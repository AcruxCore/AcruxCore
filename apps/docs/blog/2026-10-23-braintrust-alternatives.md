---
title: "10 Braintrust alternatives for LLM evals: open source and self-hosted (2026)"
description: "Ten Braintrust alternatives compared on eval features, license, self-hosting and price: which replace the whole platform and which replace only the evals."
title_meta: "10 Best Braintrust Alternatives for LLM Evals (2026)"
slug: braintrust-alternatives
date: 2026-10-23
authors: [acrux]
tags: [llmops-comparison, prompt-management]
image: /img/blog/braintrust-alternatives/01-header.webp
keywords: [braintrust alternatives, braintrust competitors, alternatives to braintrust, open source braintrust alternative, self-hosted braintrust alternative, braintrust self hosted, braintrust pricing, best braintrust alternatives]
last_update:
  date: 2026-10-25
---

![Braintrust alternatives in a grid, each with what it is best for, coloured by license: AcruxCore (ours), MLflow, Opik, LangWatch, Langfuse, DeepEval and promptfoo open source, Arize Phoenix source-available, LangSmith and W&B Weave closed source](/img/blog/braintrust-alternatives/01-header.webp)

This post compares ten Braintrust alternatives on eval features, license, self-hosting and price.
Tools that replace the whole Braintrust platform come first, then tools that replace only its
evals.

We build AcruxCore, one of the tools in this post. We do not rank it.

<!-- truncate -->

**The short answer**

- **If you need the whole platform, not only evals:** AcruxCore (ours) or MLflow. Like
  Braintrust, both have prompt versions, a gateway, tracing and evals. Both are Apache-2.0 and
  free to self-host: AcruxCore on Postgres and Redis, MLflow as one server.
- **If you only need evals:** Opik or LangWatch. Both have online scoring, review queues,
  simulated conversations and a prompt optimizer, under Apache-2.0.
- **Largest open-source community:** Langfuse, with 36,448 GitHub stars on 25 October 2026. No
  eval feature needs Langfuse's paid enterprise license.
- **Evals as tests in CI, with no server:** promptfoo or DeepEval.
- **A hosted platform charged per seat:** LangSmith, at $39 per seat a month.

## Braintrust competitors at a glance

**License, hosting and price**

| Tool | License | Self-host | Gateway | Hosted free plan | Cheapest paid plan |
|---|---|---|---|---|---|
| **Braintrust** | Closed source; SDKs Apache-2.0 | Enterprise plan only | Hosted, in public preview | Starter: 1 GB, 10,000 scores, 14 days | Pro: $249 a month |
| AcruxCore (ours) | Apache-2.0 | Free | Yes, with budgets and rate limits | Free; span content kept 90 days | None; the hosted plan is free |
| MLflow | Apache-2.0 | Free | Yes, with budgets | None outside Databricks | Through Databricks |
| Opik | Apache-2.0 | Free | Beta, for development and testing | 25,000 spans a month, 60 days | Pro: $19 a month |
| LangWatch | Apache-2.0; `enterprise/` folder commercial | Free | In the enterprise folder | 50,000 events, 2 users, 14 days | Growth: €29 per seat a month |
| Langfuse | MIT core; enterprise (`ee/`) folders commercial | Free | No | 50,000 units, 2 users, 30 days | Core: $29 a month |
| Arize Phoenix | Elastic License 2.0 | Free | No | Arize AX Free: 25,000 spans, 15 days | Arize AX Pro: $50 a month |
| DeepEval / Confident AI | Library Apache-2.0; platform closed | Library free; platform Enterprise only | No | 2 seats, 1 project | Starter: $200 a month |
| promptfoo | MIT | Free (CLI) | No | No hosted plan | Enterprise, no public price |
| LangSmith | Closed source; SDKs MIT | Enterprise plan only | Beta | 5,000 traces, 1 seat, 14 days | Plus: $39 per seat a month |
| W&B Weave | SDK Apache-2.0; server needs a license | Enterprise plan only | No | 1 GB of trace data a month | Pro: from $60 a month |

Plans and prices as read on each vendor's pricing page on 21 October 2026.

A **span** is one step inside a trace. Each vendor bills in its own unit. A Langfuse unit is one
trace, span or score, and LangWatch counts events.

**Eval features in each tool's free version**

| Tool | Built-in judges | Online scoring of live traffic | Review queues | CI | Multi-turn simulation | Prompt optimizer |
|---|---|---|---|---|---|---|
| **Braintrust** (hosted only) | Yes (`autoevals`) | Yes | Yes | GitHub Action | Scores whole sessions | Loop, an agent, suggests prompt edits |
| AcruxCore (ours) | One judge, or your own judge prompt | Yes, with alerts | No | No | No simulator; replays a real conversation | Yes |
| MLflow | Yes | Yes, LLM judges only | Experimental | pytest | Yes | Yes |
| Opik | 43 metrics | Yes | Yes | pytest plugin | Yes | Yes |
| LangWatch | Yes | Yes | Yes | SDK exit code | Yes | Yes (DSPy) |
| Langfuse | Judge templates | Yes | Yes | GitHub Action | No | No |
| Arize Phoenix | Yes | Not released yet | No | pytest, Vitest | No | No; a DSPy tutorial |
| DeepEval (library) | Yes | Confident AI only | Confident AI only | pytest | Yes | Yes |
| promptfoo | Yes | No | No | GitHub Action | Yes | Yes |
| LangSmith (hosted only) | Yes | Yes | Yes | pytest, Vitest | Yes | Partial |
| W&B Weave (hosted only) | Yes | Yes | Yes | No | Agent evals | No |

Every tool here has datasets, experiments you can compare, and scorers you write in code.
**Online scoring** means a rule scores a sample of production calls as they happen. A **review
queue** sends chosen traces to people who grade them.

:::tip[Our product: AcruxCore]

We build AcruxCore, so we do not rank it. AcruxCore has the same four parts as Braintrust: prompt
versions, a gateway, tracing and evals. AcruxCore is Apache-2.0 and self-hosts for free on
Postgres and Redis. It fits a team that wants to replace the whole platform on its own servers. It does not fit
a team that only needs evals: it has one built-in judge, no review queues and no CI integration.
The details are in [About AcruxCore](#about-acruxcore).

:::

## Why look for Braintrust alternatives?

- **Braintrust has no plan between $0 and $249 a month.** Pro then charges $3 for each GB over
  5 GB and $1.50 for each 1,000 scores over 50,000.
- **There is no hard spending limit.** Braintrust's billing FAQ says so directly. You can set
  spend alerts, but they do not stop usage.
- **Self-hosting needs an Enterprise contract.** Even then, Braintrust hosts the web UI and the
  sign-in. Only the data plane, which stores your logs and serves the API, runs in your cloud.
  The data plane needs a license key.
- **Braintrust stores your provider keys.** In May 2026, Braintrust confirmed unauthorized access
  to one of its AWS accounts, which held the provider API keys customers had saved. Braintrust
  asked every customer to rotate those keys, and said one customer was affected.
- **The free plan changed.** On 16 March 2026, the Free plan became Starter. Organizations that
  signed up before that date keep some features that new Starter organizations lack, such as
  full role-based access.

> **Key point:** Braintrust has no hard spending limit, and its spend alerts do not stop usage.
> Self-hosting Braintrust needs an Enterprise contract.

![Five reasons teams look past Braintrust: no plan between $0 and $249, no hard spend limit, self-hosting on Enterprise only, key rotation after the May 2026 incident, and the Free plan becoming Starter](/img/blog/braintrust-alternatives/02-why.webp)

Sources: [pricing](https://www.braintrust.dev/pricing),
[billing FAQ](https://www.braintrust.dev/docs/admin/billing/faq),
[self-hosting](https://www.braintrust.dev/docs/guides/self-hosting),
[architecture](https://www.braintrust.dev/docs/admin/self-hosting/architecture),
[TechCrunch on the breach](https://techcrunch.com/2026/05/06/ai-evaluation-startup-braintrust-confirms-breach-tells-every-customer-to-rotate-sensitive-keys/),
[Starter plan](https://www.braintrust.dev/blog/starter-plan).

### Braintrust pricing in 2026

| Plan | Price | Data included | Scores included | Data kept |
|---|---|---|---|---|
| Starter | $0 | 1 GB, then $4 per GB | 10,000, then $2.50 per 1,000 | 14 days |
| Pro | $249 a month | 5 GB, then $3 per GB | 50,000, then $1.50 per 1,000 | 30 days |
| Enterprise | Custom, billed yearly | Custom | Custom | Up to 365 days |

Prices as read on the Braintrust pricing page on 21 October 2026.

Every plan has unlimited users. Startups at Series A or earlier can get Pro free for 6 to 12
months.

> **Key point:** Braintrust Pro costs $249 a month and keeps data for 30 days. Every Braintrust plan
> has unlimited users.

## How we picked and ranked

- **The tool does Braintrust's core job:** you run a dataset through your app and score the
  results.
- **The tool is active.** Each one had a release or a commit in October 2026.
- **Braintrust is a platform, so tools that replace the whole platform rank first.** Braintrust
  versions prompts, logs production traces, runs a gateway and runs evals. Open-source tools
  with all four parts come first, then open-source tools focused on evals. Source-available
  tools, code-only libraries and closed hosted products follow, in that order.
- **Inside each group, a tool with more eval features in its free version ranks higher.**
- **AcruxCore is not ranked.** We build it, so it has its own section after the ranked tools.
- **Every fact comes from the vendor:** the pricing page, the docs, the license file or the
  GitHub API, read on 21 October 2026. We do not use other comparison lists as sources.

## Open-source Braintrust alternative with a gateway

AcruxCore (ours) and MLflow each replace all four parts of Braintrust: prompt versions, a
gateway, tracing and evals. Both are Apache-2.0 and free to run on your own servers. MLflow is
ranked below. AcruxCore is not ranked, because we build it; it is described in
[About AcruxCore](#about-acruxcore).

![Two columns. Whole platform: prompts, gateway, tracing and evals, covered by AcruxCore and MLflow. Evals only: Opik, LangWatch and Langfuse](/img/blog/braintrust-alternatives/03-platform-or-evals.webp)

### 1. MLflow

MLflow vs Braintrust: MLflow also has prompt versions, a gateway, tracing and evals, in one
Apache-2.0 server from the Linux Foundation.

**Best for:** teams that already run MLflow for classic machine learning.

| | MLflow | Braintrust |
|---|---|---|
| License | Apache-2.0 | Closed source |
| Self-host | One server on SQLite; Postgres and S3 for production | Enterprise only |
| Cheapest paid plan | No public price; the managed version comes with Databricks | Pro: $249 a month |

**Where MLflow differs**

- MLflow ships judges for correctness, safety, retrieval and tool calls. It can also tune a
  judge to agree with your own labels.
- MLflow simulates conversations and scores each session.
- The gateway rejects calls over a USD budget. Braintrust has spend alerts only.
- Tests written with pytest run your evals in CI.

**Limits of MLflow**

- Online scoring runs LLM judges only, not code scorers.
- Review queues are experimental. Some kinds of review-queue input work only on Databricks.

Our comparison: [AcruxCore vs MLflow](/blog/acruxcore-vs-mlflow).

Sources: [license](https://github.com/mlflow/mlflow/blob/master/LICENSE.txt),
[judges](https://mlflow.org/docs/latest/genai/eval-monitor/scorers/llm-judge/predefined/),
[online evaluation](https://mlflow.org/docs/latest/genai/eval-monitor/automatic-evaluations/),
[review queues](https://mlflow.org/docs/latest/genai/assessments/review-queues/),
[simulation](https://mlflow.org/docs/latest/genai/eval-monitor/running-evaluation/conversation-simulation/).

## Open-source Braintrust alternatives for evals

These three tools replace Braintrust's eval work. None of them has a production gateway in its
free version. The core of each uses a license approved by the Open Source Initiative, and each
is free to self-host.

### 2. Opik

Opik vs Braintrust: Opik, from Comet, has every eval feature in the feature table at the top
of this post, in its free self-hosted version. Its cloud plan costs $19 a month, against $249 for Braintrust Pro.

**Best for:** teams that want Braintrust's eval features on their own servers.

| | Opik | Braintrust |
|---|---|---|
| License | Apache-2.0, the same code as the cloud | Closed source |
| Self-host | MySQL, Redis, ClickHouse, ZooKeeper, MinIO, plus app services | Enterprise only |
| Cheapest paid plan | Pro: $19 a month, 100,000 spans, 60 days | Pro: $249 a month, 30 days |

**Where Opik differs**

- Opik ships 43 built-in metrics. Among them are 19 LLM judges, such as hallucination, G-Eval
  and agent task completion.
- Online rules score live traces, including whole conversations.
- Opik simulates a user, so you can test an agent over many turns.
- The optimizer package rewrites prompts and agents for you, with six algorithms, including
  GEPA and an evolutionary one.

**Limits of Opik**

- Self-hosted Opik has no user management, so everyone who can reach it sees everything.
- A self-hosted install runs MySQL, Redis, ClickHouse, ZooKeeper and MinIO.

Our comparison: [AcruxCore vs Opik](/blog/acruxcore-vs-opik).

Sources: [repository](https://github.com/comet-ml/opik),
[metrics](https://www.comet.com/docs/opik/evaluation/metrics/overview),
[online rules](https://www.comet.com/docs/opik/production/online-evaluation/rules),
[multi-turn](https://www.comet.com/docs/opik/evaluation/advanced/evaluate_multi_turn_agents),
[self-hosting](https://www.comet.com/docs/opik/self-host/overview),
[pricing](https://www.comet.com/site/pricing/).

### 3. LangWatch

LangWatch vs Braintrust: LangWatch is an Apache-2.0 platform built around testing agents with
simulated users, and it self-hosts for free.

**Best for:** teams that ship chat or voice agents and want to test whole conversations.

| | LangWatch | Braintrust |
|---|---|---|
| License | Apache-2.0; `enterprise/` folder commercial | Closed source |
| Self-host | Postgres, Redis, ClickHouse, app, workers, two eval services | Enterprise only |
| Cheapest paid plan | Growth: €29 per seat a month, 200,000 events, 30 days | Pro: $249 a month |

**Where LangWatch differs**

- Scenario, its testing library, tests your agent against a simulated user. It also tests voice
  agents and runs red-team attacks.
- LangWatch optimizes prompts with DSPy and scores each new version with Scenario tests.
- Review queues and online monitors are in the open-source version. The enterprise folder holds
  SSO, SCIM and billing.

**Limits of LangWatch**

- LangWatch had 4,992 GitHub stars on 25 October 2026, and Opik had 22,907.
- CI support is an SDK call that exits with code 1 when an evaluation fails. There is no GitHub
  Action.

Sources: [license](https://github.com/langwatch/langwatch/blob/main/LICENSE.md),
[enterprise folder](https://github.com/langwatch/langwatch/blob/main/enterprise/README.md),
[agent testing](https://langwatch.ai/docs/agent-testing/overview),
[CI](https://langwatch.ai/docs/evaluations/experiments/ci-cd),
[pricing](https://langwatch.ai/pricing).

### 4. Langfuse

Langfuse vs Braintrust: Langfuse is the open-source LLM platform with the most GitHub stars:
36,448 on 25 October 2026. Its cloud plan costs $29 a month, against $249 for Braintrust Pro.

**Best for:** teams that want tracing, prompts and evals in one open-source tool with a large
community.

| | Langfuse | Braintrust |
|---|---|---|
| License | MIT core; enterprise (`ee/`) folders commercial | Closed source |
| Self-host | Postgres, ClickHouse, Redis, S3, web, worker | Enterprise only |
| Cheapest paid plan | Core: $29 a month, 100,000 units, 90 days | Pro: $249 a month, 30 days |

**Where Langfuse differs**

- LLM judges, review queues, datasets, the playground and experiments are all free when
  self-hosted. The enterprise license covers admin features, such as audit logs and SCIM.
- A GitHub Action runs an experiment on each pull request.
- Langfuse Core keeps data 90 days. Braintrust Pro keeps it 30 days.

**Limits of Langfuse**

- Langfuse has no conversation simulator and no prompt optimizer.
- A self-hosted Langfuse runs Python code scorers only through AWS Lambda. Without Lambda, it
  runs TypeScript scorers only.

ClickHouse acquired Langfuse in January 2026, and the core is still MIT.

Our comparison: [AcruxCore vs Langfuse](/blog/acruxcore-vs-langfuse). For more options starting
from Langfuse, see [8 Langfuse alternatives](/blog/langfuse-alternatives).

Sources: [license](https://github.com/langfuse/langfuse/blob/main/LICENSE),
[self-host pricing](https://langfuse.com/pricing-self-host),
[code evaluators](https://langfuse.com/docs/evaluation/evaluation-methods/code-evaluators),
[CI](https://langfuse.com/docs/evaluation/experiments/experiments-ci-cd),
[pricing](https://langfuse.com/pricing).

## Source-available: Arize Phoenix

### 5. Arize Phoenix

Phoenix vs Braintrust: Phoenix self-hosts in one container with no feature limits. Its license,
the Elastic License 2.0, is not approved by the Open Source Initiative.

**Best for:** engineers who want free self-hosted evals on OpenTelemetry, with the fewest parts to
run.

| | Arize Phoenix | Braintrust |
|---|---|---|
| License | Elastic License 2.0 | Closed source |
| Self-host | One container, SQLite or Postgres | Enterprise only |
| Cheapest paid plan | Arize AX Pro: $50 a month, 50,000 spans, 30 days | Pro: $249 a month |

**Where Phoenix differs**

- Phoenix ships judges for faithfulness, hallucination, tool selection and refusals.
- The server runs Python and TypeScript code scorers in a sandbox.
- Phoenix's docs say self-hosting has "no feature gates". The license forbids selling Phoenix to
  others as a hosted service.

**Limits of Phoenix**

- Phoenix has no review queues, but you can annotate a single trace by hand.
- Online scoring on the server is not released yet, and its GitHub issues are still open.

Our comparison: [AcruxCore vs Phoenix](/blog/acruxcore-vs-phoenix).

Sources: [license](https://github.com/Arize-ai/phoenix/blob/main/LICENSE),
[license page](https://arize.com/docs/phoenix/self-hosting/license),
[server evals](https://arize.com/docs/phoenix/evaluation/server-evals/overview),
[review queues issue](https://github.com/Arize-ai/phoenix/issues/11651),
[pricing](https://arize.com/pricing/).

## Eval libraries that run in CI

These two tools run evals as code, with no server to keep running. Neither one scores production
traffic in its free version.

### 6. DeepEval and Confident AI

DeepEval vs Braintrust: DeepEval is an Apache-2.0 Python library for evals. Confident AI is its
closed, hosted platform, priced below Braintrust Pro.

**Best for:** Python teams that want evals as pytest tests.

| | DeepEval / Confident AI | Braintrust |
|---|---|---|
| License | DeepEval Apache-2.0; Confident AI closed | Closed source |
| Self-host | DeepEval runs anywhere; Confident AI Enterprise only | Enterprise only |
| Cheapest paid plan | Confident AI Starter: $200 a month per organization | Pro: $249 a month |

**Where DeepEval differs**

- DeepEval's metrics cover RAG, agents, conversations, voice, MCP and safety.
- G-Eval and DAG, two judge builders in DeepEval, let you write your own judge.
- `deepeval test run` runs your evals as pytest tests in CI.
- The library simulates conversations and generates test cases for you.
- DeepEval optimizes prompts with four algorithms, such as GEPA and MIPROv2.

**Limits of DeepEval**

- The open-source library has no web UI. Side-by-side experiments, online scoring and review
  queues need Confident AI.
- Self-hosting Confident AI needs an Enterprise plan and a license key.

Sources: [repository](https://github.com/confident-ai/deepeval),
[metrics](https://deepeval.com/docs/metrics-introduction),
[CI](https://deepeval.com/docs/evaluation-unit-testing-in-ci-cd),
[Confident AI self-hosting](https://www.confident-ai.com/docs/self-hosting),
[pricing](https://www.confident-ai.com/pricing).

### 7. promptfoo

promptfoo vs Braintrust: promptfoo is an MIT command-line tool that runs evals and red-team tests
from a config file. OpenAI agreed to acquire it in March 2026.

**Best for:** engineers who want eval and security tests to run in CI, with no server.

| | promptfoo | Braintrust |
|---|---|---|
| License | MIT | Closed source |
| Self-host | CLI and a local web viewer | Enterprise only |
| Cheapest paid plan | Enterprise, no public price | Pro: $249 a month |

**Where promptfoo differs**

- A matrix view shows every prompt and model side by side, for every test case.
- Red teaming is its main focus, with attacks mapped to OWASP and the EU AI Act.
- A GitHub Action runs the evals on each pull request.
- `promptfoo optimize` rewrites prompts, and a simulated user tests multi-turn chats.

**Limits of promptfoo**

- promptfoo tests before you ship. It does not score production traffic.
- Its self-hosted sharing server has no sign-in. The promptfoo docs say it is not recommended for
  production.

Sources: [license](https://github.com/promptfoo/promptfoo/blob/main/LICENSE),
[OpenAI acquisition](https://www.promptfoo.dev/blog/promptfoo-joining-openai/),
[GitHub Action](https://www.promptfoo.dev/docs/integrations/github-action/),
[self-hosting](https://www.promptfoo.dev/docs/usage/self-hosting/),
[pricing](https://www.promptfoo.dev/pricing/).

## Closed-source alternatives

LangSmith and W&B Weave publish no server code. Self-hosting either one needs an enterprise
contract.

### 8. LangSmith

LangSmith vs Braintrust: LangSmith, from the LangChain team, has datasets, judges, review queues,
online scoring and multi-turn simulation. It charges per seat, where Braintrust charges a flat
price.

**Best for:** apps built on LangChain or LangGraph.

| | LangSmith | Braintrust |
|---|---|---|
| License | Closed source; SDKs MIT | Closed source; SDKs Apache-2.0 |
| Self-host | Enterprise plan only | Enterprise plan only |
| Cheapest paid plan | Plus: $39 per seat a month, 10,000 traces, 14 days | Pro: $249 a month, unlimited users, 30 days |

**Where LangSmith differs**

- LangSmith scores the steps an agent took and simulates multi-turn chats.
- LangSmith has review queues, online judges, and test runners for pytest and Vitest.
- Plus costs $39 per seat, so a team of six or fewer pays less than Braintrust Pro, before
  trace charges.

**Limits of LangSmith**

- LangSmith keeps base traces 14 days. Keeping a trace longer costs extra.
- An online scoring rule moves every trace it matches to the longer, paid retention.

Our comparison: [AcruxCore vs LangSmith](/blog/acrux-core-vs-langsmith). For more options
starting from LangSmith, see [8 LangSmith alternatives](/blog/langsmith-alternatives).

Sources: [pricing](https://www.langchain.com/pricing),
[self-hosting](https://docs.langchain.com/langsmith/architectural-overview),
[online rules](https://docs.langchain.com/langsmith/rules),
[multi-turn simulation](https://docs.langchain.com/langsmith/multi-turn-simulation).

### 9. W&B Weave

Weave vs Braintrust: Weave, from Weights & Biases, has review queues, monitors and leaderboards.
Its Pro plan starts at $60 a month, against $249 for Braintrust Pro.

**Best for:** teams that already track training runs in Weights & Biases.

| | W&B Weave | Braintrust |
|---|---|---|
| License | SDK Apache-2.0; server needs a W&B license | Closed source |
| Self-host | Enterprise plan only; ClickHouse, MySQL, Redis, S3 on Kubernetes | Enterprise plan only |
| Cheapest paid plan | Pro: from $60 a month, up to 10 seats | Pro: $249 a month |

**Where Weave differs**

- Leaderboards rank models and prompts across many evaluations.
- Monitors run LLM judges on a sample of live calls.
- Weave keeps LLM traces in the same W&B account as your training runs and model registry.

**Limits of Weave**

- Pro includes 1.5 GB of trace data a month, then $0.10 per MB. Eval runs that log full inputs
  and outputs count against that 1.5 GB.
- Weave has no built-in prompt optimizer.

Sources: [pricing](https://coreweave.com/forge-pricing),
[self-managed Weave](https://docs.coreweave.com/weave/guides/platform/weave-self-managed),
[comparing evaluations](https://docs.coreweave.com/products/wandb/weave/guides/evaluation/compare_evals),
[monitors](https://docs.coreweave.com/products/wandb/weave/guides/evaluation/custom-monitors).

## About AcruxCore

AcruxCore is our own product, so it has no rank in this list.

AcruxCore vs Braintrust: AcruxCore has the same four parts as Braintrust: prompt versions, a
gateway, tracing and evals. AcruxCore is Apache-2.0 and self-hosts on Postgres and Redis, while
Braintrust self-hosts only on Enterprise.

**Best for:** teams that want to replace the whole Braintrust platform, not only the evals, and
run it on their own servers.

| | AcruxCore | Braintrust |
|---|---|---|
| License | Apache-2.0, with no enterprise folder | Closed source |
| Self-host | Postgres, Redis, API, worker, web | Enterprise only |
| Gateway | Yes; stops calls at a spend budget or a rate limit | Hosted, in public preview; spend alerts only |
| Cheapest paid plan | None; the hosted plan is free | Pro: $249 a month |

**Where AcruxCore differs**

- The gateway refuses a call that would go over a spend budget. It also limits requests and
  tokens per key. Braintrust has spend alerts that do not stop usage.
- When you self-host AcruxCore, your provider keys stay in your own database.
- Roles, the audit log and prompt aliases such as `production` are free. Braintrust puts roles
  on Pro and audit logs on Enterprise.
- An experiment runs several prompt versions on several models against one dataset. A compare
  page then shows which examples improved and which got worse.
- Your team can rate a reply thumbs down and leave a comment. A dataset built from those
  ratings uses each comment as that example's grading criteria.
- An optimize run reads those rated replies and rewrites your production prompt. AcruxCore then
  scores each rewrite against the current production version.
- Online rules score a sample of live calls. A rule alerts the team's owners when its mean score
  for the day falls below a threshold you set.

**Limits of AcruxCore**

- If evals are all you need, Opik and LangWatch have more eval features: a metric library,
  review queues and a conversation simulator. AcruxCore has one built-in judge, and you can
  write your own judge prompt.
- AcruxCore has no CI integration.
- The repository went public in August 2026 and had 11 GitHub stars on 25 October 2026.

Our comparison: [AcruxCore vs Braintrust](/blog/acruxcore-vs-braintrust). The eval guides start
at [Evaluate a prompt against a dataset](https://docs.acruxcore.com/docs/guides/evaluate-a-prompt).

Sources: [license](https://github.com/AcruxCore/AcruxCore/blob/main/LICENSE),
[compose file](https://github.com/AcruxCore/AcruxCore/blob/main/docker-compose.local.yml),
[pricing](https://acruxcore.com/pricing).

## Tools other lists still recommend

Older lists of Braintrust alternatives still include these tools. Their status on
21 October 2026:

- **Galileo** was acquired by Cisco and is now sold as Splunk Agent Observability.
  ([source](https://www.splunk.com/en_us/about-splunk/acquisitions/galileo.html))
- **Humanloop** shut down on 8 September 2025, after its team joined Anthropic.
  ([source](https://humanloop.com/docs/guides/migrating-from-humanloop))
- **Patronus AI** now calls itself a research lab for training data and simulated environments.
  Its pricing page shows no prices. ([source](https://www.patronus.ai/))
- **HoneyHive** has a free plan and Enterprise, with no public paid plan in between. Self-hosting
  needs Enterprise. ([source](https://www.honeyhive.ai/pricing))
- **Future AGI** went public on GitHub in April 2026 under Apache-2.0, with an enterprise folder
  under its own license. ([source](https://github.com/future-agi/future-agi))

## Which Braintrust alternative should you pick?

Start at the top and stop at the first question you answer yes to.

![Decision flow: need prompts, gateway and evals in one app leads to AcruxCore; already run MLflow leads to MLflow; testing agents over many turns leads to LangWatch or Opik; evals as tests in CI leads to promptfoo or DeepEval; otherwise Opik or Langfuse](/img/blog/braintrust-alternatives/04-decision.webp)

### Best open-source Braintrust alternative

- **AcruxCore** (ours) or **MLflow** if you need the whole platform: prompts, a gateway,
  tracing and evals, free to self-host.
- **Opik** if you only need evals. It has the most eval features of any free self-hosted tool.
- **Langfuse** for the largest community, with every eval feature free.

### Best self-hosted Braintrust alternative for a small team

- **MLflow** for one server on SQLite, with a gateway that rejects calls over a USD budget.
- **Arize Phoenix** for evals only, with the fewest parts to run: one container on SQLite.
- **AcruxCore**, our own product, runs as one app on Postgres and Redis, with a gateway that
  enforces spend budgets.

### If you test agents over many turns

- **LangWatch** and **Opik** test your agent against a simulated user.
- **MLflow** simulates conversations and scores each session.

### If evals should run as tests in CI

- **promptfoo** for a config file, a GitHub Action and red teaming.
- **DeepEval** for pytest and metrics for RAG, agents and conversations.

### If you want to stay hosted

- **LangSmith** has review queues, online judges and simulation. It costs less than Braintrust
  Pro for teams of six or fewer.
- **Opik Pro** costs $19 a month, against $249 for Braintrust Pro.

## FAQ

### Is Braintrust open source?

No. The Braintrust server is closed source. The SDKs are Apache-2.0, and the `autoevals` scorer
library is MIT. ([autoevals](https://github.com/braintrustdata/autoevals))

### Can you self-host Braintrust?

Only on the Enterprise plan. The data plane runs in your AWS, GCP or Azure account and needs a
license key. Braintrust still hosts the web UI and sign-in.
([self-hosting](https://www.braintrust.dev/docs/guides/self-hosting))

### How much does Braintrust cost?

Starter is free, with 1 GB of data and 10,000 scores a month. Pro costs $249 a month. Enterprise
has a custom price. ([pricing](https://www.braintrust.dev/pricing))

### Was Braintrust breached?

In May 2026, Braintrust confirmed unauthorized access to one of its AWS accounts. It asked every
customer to rotate the AI provider keys stored in Braintrust, and said one customer was affected.
([TechCrunch](https://techcrunch.com/2026/05/06/ai-evaluation-startup-braintrust-confirms-breach-tells-every-customer-to-rotate-sensitive-keys/))

### Does Braintrust have spending limits?

No. Braintrust has spend alerts, but its billing FAQ says it has no hard limits that stop usage.
([billing FAQ](https://www.braintrust.dev/docs/admin/billing/faq))

## Related posts

- [AcruxCore vs Braintrust](/blog/acruxcore-vs-braintrust): the same prompt and tool run on both,
  with screenshots.
- [8 Langfuse alternatives](/blog/langfuse-alternatives): the same comparison, starting from
  Langfuse.
- [8 LangSmith alternatives](/blog/langsmith-alternatives): the same comparison, starting from
  LangSmith.
- [10 LLM observability tools tested hands-on](/blog/hands-on-llm-ops-comparison): screenshots
  of each tool.
- [Self-hosting LLM observability tools: seven measured, six open source](/blog/self-hosting-llm-observability):
  memory, disk and trace storage for each stack on one machine.
