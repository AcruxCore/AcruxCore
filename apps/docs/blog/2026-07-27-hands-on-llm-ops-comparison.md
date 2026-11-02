---
title: "10 LLM Observability Tools Tested Hands-On (2026)"
description: We tested 10 LLM observability tools hands-on, including Langfuse, Opik, MLflow, Laminar and Agenta, and compare tracing, evals and latency.
slug: hands-on-llm-ops-comparison
authors: [acrux]
tags: [llmops-comparison, prompt-management, llm-tracing]
image: /img/blog/hands-on-llm-ops-comparison/header.webp
keywords: [llm observability tools, ai observability, llm monitoring, ai agent observability, llm tracing comparison, llm evaluation comparison, prompt management comparison, llm ops comparison]
last_update:
  date: 2026-11-02
---

![Ten LLM observability tools, each with a feature only it has: LangSmith pairwise experiments, Langfuse prompt references, PromptLayer A/B tests, Phoenix retention per project, Opik test suites, MLflow guardrails and budgets, Helicone rate limit rules, Laminar SQL over spans, Agenta webhooks on deploy and AcruxCore's versioned tool catalog](/img/blog/hands-on-llm-ops-comparison/header.webp)

Most comparisons of LLM observability tools are written from docs and marketing pages. This one
is written from running them. We tested **LangSmith**, **Langfuse**, **PromptLayer**, **Arize
Phoenix**, **Opik**, **MLflow**, **Helicone**, **Laminar** and **Agenta**, plus **AcruxCore**.
On each one we created a prompt, versioned it, ran it with a real model key, opened the trace
and tried to build an evaluation. Then we ran a script against each tool's SDK and timed it
against a direct call to the provider.

The post is organised by feature, not by tool. Each section answers one question: which tools
do this, and how well? We build AcruxCore, so weigh its rows with that in mind.

**The short answer**

- **Deepest agent traces:** Laminar. It nests every step of an agent run and lets you query
  spans with SQL.
- **Most evaluation tooling:** Agenta (11 built-in evaluator types, plus five regex presets), Opik (test suites and
  online evaluation) and LangSmith (pairwise experiments).
- **Content guardrails:** Opik and MLflow. Helicone's docs also describe security and moderation
  checks for OpenAI models (per docs, not tested).
- **Stopping a call over budget:** MLflow and AcruxCore. Both sit in the request path. Helicone
  sits there too and has rate-limit rules.
- **Prompt templates with real `if` and `for` logic:** MLflow and AcruxCore.
- **Tools as versioned objects:** only AcruxCore has a tool catalog that runs and measures each
  tool.

<!-- truncate -->

## What is LLM observability?

LLM observability means recording what your model calls do, so you can debug and improve them.
A tool in this category records each call as a trace: the prompt, the response, the tokens, the
cost and the latency. For an agent, one trace holds every step of a run. Each model call and
each tool call is a span, a timed record of one step. LLM monitoring watches those traces over
time for cost, latency and errors. Most tools here also store prompt versions, run evaluations
and collect user feedback.

## How we tested

We tested in two groups, on two prompts.

- **Group 1:** LangSmith, Langfuse and PromptLayer ran in one pass with AcruxCore, on a
  `support-triage` prompt.
- **Group 2:** Phoenix, Opik, MLflow, Helicone, Laminar and Agenta were each compared one-on-one
  with AcruxCore. They used a second prompt, `vip-support-triage`, with a VIP conditional and a
  loop over open tickets.

The two groups never ran against each other. Read a row that spans all ten as two passes put
together. The latency table is the exception: all its rows come from group 2, against the same
OpenAI baseline.

| Tool | When | Setup |
|---|---|---|
| LangSmith | July 2026 | Hosted, US region |
| Langfuse | July 2026; templates re-checked 2 November 2026 | Langfuse Cloud EU, web app v4.0.0-rc.2 |
| PromptLayer | July 2026 | Hosted, Team trial |
| Phoenix | 7 August 2026 | Self-hosted |
| Opik | 7 August 2026 | Self-hosted |
| MLflow | 8 August 2026 | Self-hosted, MLflow 3.15.1 |
| Helicone | August 2026 | Self-hosted |
| Laminar | Before 6 September 2026 | Self-hosted |
| Agenta | Before 19 October 2026 | Self-hosted, Agenta 0.122.7 |
| AcruxCore | Every pass | Hosted and self-hosted |

We did not record the version for most tools. Where a version is known, the table shows it.
Prices, licences and docs claims were checked on 2 November 2026 unless a section says
otherwise. Each tool also has its own full post, linked in [Further reading](#further-reading).

## At a glance

Each row is one need. The first column names the tools that did it best in our tests.

| Need | Strongest in our tests | Also has it | AcruxCore |
|---|---|---|---|
| Prompt templates with `if`/`for` logic | MLflow | Agenta, Phoenix (Mustache sections) | Yes, nunjucks, rendered on the server |
| Prompt versions with a live pointer | Nine of ten | Laminar has no prompt registry | Yes, aliases and a Diff tab |
| Agent trace depth | Laminar | LangSmith, Langfuse, Phoenix, Agenta | One span per gateway call; the SDK nests tool calls in one trace |
| Tracing with no SDK setup | MLflow, AcruxCore (gateway) | Agenta's invoke endpoint | Yes |
| Evaluation tooling | Agenta, Opik, LangSmith | Langfuse, Phoenix, MLflow, Laminar, PromptLayer | Partial: datasets and online rules, no rule evaluators |
| Content guardrails | Opik, MLflow | Helicone, OpenAI models only (per docs, not tested); Laminar redacts PII from stored spans | No |
| Spend caps before the call | MLflow, AcruxCore | Helicone rate-limit rules | Yes, `402` and `429` |
| Feedback to a better prompt | AcruxCore (dashboard) | Opik and MLflow optimizers (SDK only) | Yes, Improve from feedback |
| Tool catalog | AcruxCore (the only one) | MLflow lists MCP servers | Yes, versioned, with analytics |
| SQL over your traces | Laminar | Helicone HQL, on selected workspaces (per docs, not tested) | No |
| Smallest self-hosted server | Phoenix, AcruxCore (1 GB) | Laminar (2 GB) | 1 GB |

The sections below give the evidence for each row.

## Prompt management

:::info[Quick take]
MLflow and AcruxCore render real `if` and `for` logic. Agenta renders it too, but its editor
misses the variables inside it. Laminar has no prompt registry at all.
:::

Nine of the ten tools store immutable versions and move a pointer, such as `production`, between
them. They differ in how much template logic survives.

| Tool | Template logic | Live/staging pointer | Diff |
|---|---|---|---|
| MLflow | Jinja2 `{% if %}` and `{% for %}`, stored as written | `@production`/`@staging` aliases, set from the SDK | Word-level diff |
| AcruxCore | Nunjucks `{% if %}` and `{% for %}`, rendered on the server | `production`/`staging` aliases | Diff tab |
| Agenta | Jinja2 renders, but the variable list misses variables used only inside tags | Three environments, deployed from the commit dialog | In the commit dialog |
| Phoenix | Mustache sections, used for both `if` and `for` | `production`/`staging` tags | Diff toggle |
| Opik | Flat `{{variable}}` in the UI dialog; the SDK has a Jinja2 type (not tested) | "Deploy to" tags | Diff panel |
| PromptLayer | Flat `{{variable}}` in our test; docs offer Jinja2 (not tested) | Release Labels | Line diff in the save dialog |
| Langfuse | `{{variable}}` only; `{% if %}` comes back as plain text | `production`/`latest` labels | No: not shown inline |
| LangSmith | f-string by default, Mustache as an option; we used flat variables | Named Environments | No: not shown inline |
| Helicone | Flat `{{ hc:var:type }}` | `production` set on version 1 | Not reached |
| Laminar | No: no prompt registry | No | No |

- 👍 **MLflow.** The strongest of the other nine. Our `{% if is_vip %}` branch and
  `{% for ticket in tickets %}` loop were stored as written, with no flattening.
- 👍 **AcruxCore.** The same logic in nunjucks. The gateway renders the template, so your code
  sends variables, not text.
- 👍 **Phoenix.** One Mustache construct does the job of both `if` and `for`. It works, with
  different syntax.
- 👎 **Agenta.** Renders both tags, but builds the variable list wrong. The list missed `is_vip`
  and `tickets`, which appear only inside the tags. The invoke endpoint returned HTTP 400 until
  we edited `input_keys` by hand.
- 👎 **Langfuse.** Only `{{variable}}` is filled in. In our 2 November 2026 test, `{% if %}` text
  came back unchanged after compiling. Langfuse has something the others lack: a prompt reference
  (`@@@langfusePrompt:name=…@@@`), which places one prompt inside another.
- 👎 **Laminar.** No prompt store. A playground holds one editable set of messages, so there is
  no version to fetch or promote. We checked the database schema, not only the UI.
- **Opik and PromptLayer.** We used flat variables in each UI. Both tools' docs describe Jinja2
  templates with conditionals and loops. We did not test them.

We promoted a version and watched the pointer move on AcruxCore, PromptLayer, Phoenix, Opik,
MLflow and Agenta. LangSmith's Environments had nothing deployed on our account, so we saw the UI
but not a live promotion.

<details>
<summary>See the actual screens: prompt versioning on nine platforms (Laminar has no prompt registry)</summary>

**LangSmith** — commit history with a hash per save, model config attached to the prompt:

![LangSmith prompt detail page showing two commits in the history and model configuration](/img/tutorials/langsmith-walkthrough/ls-02-prompt-versions.png)

**Langfuse** — immutable versions with `production`/`latest` labels, variables auto-detected:

![Langfuse prompt versions list showing v1 tagged production and v2 tagged latest](/img/tutorials/langfuse-walkthrough/lf-05-prompt-versions.jpg)

**PromptLayer** — a colored line diff shown right in the save dialog, plus Release Labels in the version history:

![PromptLayer save-new-version dialog showing a colored diff of the message changes](/img/tutorials/promptlayer-walkthrough/03-save-version-diff.png)
![PromptLayer version history panel showing versions with commit messages and a Release Label control](/img/tutorials/promptlayer-walkthrough/04-version-history-and-empty-traces.png)

**Phoenix** — Mustache sections for both the VIP conditional and the tickets loop, and a real version diff:

![Phoenix's Playground with the vip-support-triage prompt loaded, showing Mustache section syntax for the VIP conditional and the tickets loop, tagged "production", with real cost/token/latency telemetry from a live run](/img/comparison/phoenix/px-01-prompt-editor.png)
![Phoenix's version diff view — a second version highlighted in green for the one added line, with the version list and its "staging" tag alongside](/img/comparison/phoenix/px-03-diff-tab.png)

**Opik** — flat `{{variable}}` substitution in the UI dialog, a real Diff panel, and a "Deploy to" environment label:

![Opik's New chat prompt dialog for the recreated vip-support-triage prompt, showing flat {{company}} and {{customer_message}} variable substitution](/img/comparison/opik/op-01-prompt-editor.png)
![Opik's Compare v1 to v2 panel, showing the old system message in red strikethrough on the left and the new message in green on the right, side by side](/img/comparison/opik/op-03-diff-tab.png)

**MLflow** — real Jinja2 conditionals and loops, registered verbatim:

![MLflow's prompt detail page for vip-support-triage version 3, showing @production and @staging aliases, a commit message, and the full Jinja2 system template with if/else and for-loop syntax rendered as literal text](/img/comparison/mlflow/mf-01-prompt-version-3.png)
![MLflow's word-level diff between version 3 and version 2, with "4" highlighted red and "5" highlighted green on the sentence-count line](/img/comparison/mlflow/mf-02-diff-view.png)

**Helicone** — flat `{{ hc:var:type }}` substitution, and the single version this run produced:

![Helicone's Playground with the recreated vip-support-triage system message, showing the flat {{ hc:company:string }} variable syntax and the Save Prompt dialog with our commit message about flattening the nunjucks logic](/img/comparison/helicone/hl-01-prompt-editor.png)

**Agenta** — the variable panel that missed `is_vip` and `tickets`, and the commit dialog with its diff and deploy menu:

![Agenta's prompt editor with the vip-support-triage system message in Jinja2, and a variable panel that lists only company and a ticket object with id and title](/img/comparison/agenta/ag-01-jinja-variables.png)
![Agenta's commit dialog for vip-support-triage: a What's changing panel with Model and Instructions (+3 / −3), a New version tab that saves as version 2, and a Deploy to menu with production, staging and development checkboxes](/img/comparison/agenta/ag-03-commit-and-deploy.png)

**AcruxCore** — the prompt editor, the Versions tab after promoting `production` to v2, and the Diff tab:

![AcruxCore prompt editor showing version tabs including Editor, Preview, Versions, Diff, Audit](/img/tutorials/acruxcore-walkthrough/02-prompt-editor.png)
![AcruxCore Versions tab listing v2 tagged PRODUCTION and v1 tagged STAGING, each with a promote link and a View traces link](/img/tutorials/acruxcore-walkthrough/03-alias-promoted.png)
![AcruxCore's Diff tab showing a line-level, colored diff between prompt version 1 and version 2](/img/tutorials/acruxcore-walkthrough/04-diff-tab.png)

</details>

<a id="tracing-and-observability"></a>

## LLM tracing and monitoring

:::info[Quick take]
Eight tools record span-based traces by default. Laminar's are the deepest. PromptLayer logs
flat requests unless you add trace instrumentation, and our self-hosted Helicone logged nothing.
:::

| Tool | Trace shape | Setup needed | Link to the prompt version |
|---|---|---|---|
| Laminar | Nested span tree; tree, transcript and cost-heatmap views | `Laminar.initialize()` plus `@observe()` | No: no prompt registry |
| LangSmith | Parent run with child spans | `wrap_openai` plus `@traceable` | No: not tracked |
| Langfuse | Generation inside a trace, session and user badges | Drop-in OpenAI wrapper | Not checked |
| Phoenix | One rich span with OpenTelemetry attributes | `register()` plus an instrumentor | Not shown in our run |
| Opik | Outer trace with an LLM span inside | `track_openai()` | Not checked |
| Agenta | Span tree | Only for your own code: `ag.init()`, an instrumentor and a decorator | Partial: automatic for invoke, a `store_refs()` call otherwise |
| MLflow | One span per gateway call | Not needed: calls go through the gateway | Partial: needs a separate `link_prompt_versions_to_trace()` call |
| AcruxCore | One span per gateway call; tool calls nest under one trace | Not needed: calls go through the gateway | Yes: automatic |
| PromptLayer | Flat Request Log; Traces need span instrumentation | `pl_client.openai` wrapper | Not checked |
| Helicone | None recorded on our self-hosted build | Gateway base URL plus an organization key | Not reached |

- 👍 **Laminar.** The deepest of the ten. `@observe()` nests each model call under a parent span, so
  the shape of an agent run lands in the trace. Laminar lists 31 integrations, including agent
  frameworks such as Browser Use and Mastra.
- 👍 **LangSmith.** A trace showed a parent run with a tool-call span and a separate LLM span.
- 👍 **Langfuse.** A generation sits under a top-level trace, with session and user badges on the
  header. In our July test, a Playground run did not add a trace. Only calls from the instrumented
  SDK appeared.
- 👍 **Phoenix.** One span, but a rich one: Info, Attributes and Events tabs with OpenTelemetry
  attributes. Its span view is richer than AcruxCore's.
- 👍 **Opik.** `track_openai()` wraps the client you already have. The trace shows an outer trace
  with the LLM span inside.
- 👍 **AcruxCore.** Every gateway call is traced and costed, and linked to its prompt version at
  render time. When the SDK runs the tool loop, every model call and tool call lands in one trace.
- **Agenta.** A call through the invoke endpoint is traced automatically. A call from your own code
  links to its prompt only after `ag.tracing.store_refs()`. Without it, the trace page showed "No
  references found".
- **MLflow.** Every gateway call is traced. Linking the trace to the prompt version needs a
  separate call that is easy to forget.
- **PromptLayer.** Each call lands in a flat Request Log with model, latency, cost and tokens.
  Multi-step Traces stayed empty, because we did not add span instrumentation.
- **Helicone.** The gateway forwarded calls, but logged none until an organization API key was
  set. The manual log endpoint then returned HTTP 500, because the self-hosted compose file lacked
  an `S3_REGION` value. That is a setup problem of the build we ran, not a verdict on Helicone's
  hosted product.

Langfuse and AcruxCore also group traces by a session id, so a multi-turn conversation reads as
one thread.

<details>
<summary>See the actual screens: trace views on nine platforms (Helicone recorded none)</summary>

**LangSmith** — a real span tree from a live run: parent chain, prompt-template spans, and the model call, with real latency and token count:

![LangSmith trace detail showing a RunnableSequence span tree feeding into a gpt-5.6-terra span, with latency and token count](/img/tutorials/langsmith-walkthrough/ls-live-02-trace-span-tree.png)

**Langfuse** — session and user badges live on the trace header, with cost/token breakdown inline:

![Langfuse trace detail panel showing session grouping, cost, token counts, and tags](/img/tutorials/langfuse-walkthrough/lf-03-trace-detail.jpg)

**PromptLayer** — the flat Request Log (what you get by default) versus Traces, which stayed empty without span instrumentation:

![PromptLayer Request Log detail page for a live request, showing model, cost, and token counts](/img/tutorials/promptlayer-walkthrough/08-live-request-log-detail.jpg)
![PromptLayer Traces and Analytics page showing No traces found even after a live model call](/img/tutorials/promptlayer-walkthrough/09-live-traces-still-empty.jpg)

**Phoenix** — a single span, richer attribute/event tabs than AcruxCore's own view:

![Phoenix's trace detail: ChatCompletion span showing status, total cost, latency, and the full input/output messages](/img/comparison/phoenix/px-05-trace-detail.png)

**Opik** — a two-level span tree from the wrapped client:

![Opik's trace detail: a two-node span tree (outer trace + inner LLM span), 2.6s latency, <$0.01 cost, 138 total tokens, full system/user/assistant messages shown](/img/comparison/opik/op-06-trace-detail.png)

**MLflow** — automatic on every Gateway call, with prompt-version lineage requiring a separate explicit call:

![MLflow's trace detail Linked prompts tab, showing a table with one row: prompt name vip-support-triage, version 3](/img/comparison/mlflow/mf-04-trace-linked-prompt.png)

**Laminar** — a nested span tree with the full message transcript, token count, and cost on the child span:

![Laminar span detail: a tree with vip_support_triage above an openai.chat child, and a right panel showing System, User and Assistant messages with 158 tokens and $0.0001](/img/comparison/laminar/lm-04-span-llm-messages.png)

**Agenta** — an invoke call traced automatically, with Playground, Add to testset and Annotate buttons on the trace:

![Agenta trace of an invoke call: a chat_v0 workflow span over a litellm_client child, 1.77 s, $0.000044, 152 tokens, with the is_vip, company, tickets and customer_message inputs, the assistant reply citing ticket #4821, and Playground, Add to testset and Annotate buttons](/img/comparison/agenta/ag-07-invoke-trace.png)

**Helicone** — the Requests page on our self-hosted build stayed on its preview data, because the log call failed on a missing setting:

![Helicone's Requests page still showing only its static "Integrate to see your requests" preview data — our real OpenRouter calls never appear because the log call failed](/img/comparison/helicone/hl-06-datasets-empty.png)

**AcruxCore** — a gateway call auto-traced as a span, with model/provider fields visible on the span itself:

![AcruxCore trace detail page showing 1 span, token count, and status OK](/img/tutorials/acruxcore-walkthrough/06-trace-detail.png)
![AcruxCore's LLM span expanded, showing Model, Provider, Tokens, and Latency fields plus the full request Input and response Output JSON](/img/tutorials/acruxcore-walkthrough/07-trace-span-detail.png)

</details>

### Where the platform sits: in the request path, or beside it

Every tool here makes one design choice. Either your code calls the provider and the tool records
the call ("beside"), or your code calls the tool's gateway and the gateway calls the provider
("in the path").

![Where each tool sits: LangSmith, Langfuse, PromptLayer, Phoenix, Opik and Laminar record the call beside it; MLflow, Helicone and AcruxCore put a gateway in the request path; Agenta does both](/img/blog/hands-on-llm-ops-comparison/request-path.webp)

| Beside the call | In the path | Both |
|---|---|---|
| LangSmith, Langfuse, PromptLayer, Phoenix, Opik, Laminar | MLflow, Helicone, AcruxCore | Agenta: invoke endpoint in the path, SDK beside |

> **Key point:** MLflow, Helicone and AcruxCore sit in the request path and call the provider.
> LangSmith, Langfuse, PromptLayer, Phoenix, Opik and Laminar sit beside the request path.

- **What "in the path" buys.** The gateway sees the call before the provider does. It can refuse a
  call over budget, serve it from cache and trace it with no SDK step.
- **What "beside" buys.** Nothing extra can fail your production call, and any provider works at
  once. A span made inside your process also sees retries, tool loops and framework internals that
  a gateway never sees.
- **Laminar** is beside on purpose. We read its server routes, and it has no inbound proxy. The
  cost is that a budget or cache has no call left to act on.
- **Agenta's** invoke endpoint is in the path, but its source has no spend cap, per-key rate limit
  or response cache for invoke calls. Each prompt can set fallback models and a retry policy.

### Latency overhead, measured on seven of the ten

Each run made the same `gpt-4o-mini` call on `api.openai.com` three ways: direct, through the
other tool and through AcruxCore's gateway. The three legs were interleaved over 100 rounds, and
each pairing ran three times. Direct-call medians were between 599 ms and 643 ms.

| Path | Gap vs. a direct call, across 3 runs | Different from zero? |
|---|---|---|
| Phoenix OTel SDK | −14 to +21 ms | In 1 of 3 runs |
| Opik tracked SDK | +2 to +22 ms | In 1 of 3 runs |
| Laminar OTel SDK | −8 to +18 ms | In 1 of 3 runs |
| Helicone gateway | −15 to +3 ms | In 1 of 3 runs, on the faster side |
| MLflow AI Gateway | **+135 to +225 ms** | In every run |
| AcruxCore gateway | +4 to +51 ms across all 15 runs | In 8 of 15 runs |

- **The SDK tools cost almost nothing.** Phoenix, Opik and Laminar stayed within tens of
  milliseconds of a 600 ms call.
- **Helicone did less work.** On our self-hosted install it forwarded calls without logging them,
  because of a setup error. So its gap is a floor, not a like-for-like number.
- **MLflow's gateway is the only path above 100 ms.** Its interval never crossed zero. A different
  benchmark, the [full-cycle run](https://acruxcore.com/blog/full-cycle-latency-benchmark), times a
  prompt fetch plus the completion, and measured MLflow at −81 ms there. So the +135 to +225 ms
  holds for these completion-only runs, not for every MLflow setup.
- **AcruxCore's gap moved between runs.** The 15 runs range from +4 to +51 ms. A separate
  [gateway overhead benchmark](https://acruxcore.com/blog/llm-gateway-overhead), run on 25 October
  2026 with the gateway on the same machine as the app, measured a median of +9 ms. In that run the
  hosted gateway's median was 1,176 ms against 639 ms direct, which that post puts down to network
  distance.

LangSmith, Langfuse and PromptLayer were not benchmarked in these runs. Agenta's runs ended at
OpenRouter instead of OpenAI, and no path could be told apart from a direct call there, AcruxCore
included. That table is in [AcruxCore vs Agenta](https://acruxcore.com/blog/acruxcore-vs-agenta#latency-overhead-measured).

:::github
- [`phoenix-vs-acruxcore/python/latency_bench.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/phoenix-vs-acruxcore/python/latency_bench.py)
- [`opik-vs-acruxcore/python/latency_bench.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/opik-vs-acruxcore/python/latency_bench.py)
- [`mlflow-vs-acruxcore/python/latency_bench.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/mlflow-vs-acruxcore/python/latency_bench.py)
- [`helicone-vs-acruxcore/python/latency_bench.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/helicone-vs-acruxcore/python/latency_bench.py)
- [`laminar-vs-acruxcore/python/latency_bench.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/laminar-vs-acruxcore/python/latency_bench.py)
- [`agenta-vs-acruxcore/python/latency_bench.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/agenta-vs-acruxcore/python/latency_bench.py)
:::

## Evaluation

:::info[Quick take]
Agenta has the most built-in evaluators, Opik the most kinds of evaluation, and LangSmith the
only pairwise view. Laminar runs evaluations from code. AcruxCore builds datasets from feedback
and scores live traffic, but has no rule evaluators on the server.
:::

| Tool | Datasets from | Evaluators | Extra |
|---|---|---|---|
| Agenta | Test sets, traces | 11 built-in types plus five regex presets: rules, code, webhook, LLM judge | Human, live and SDK evaluations; annotation queues |
| Opik | Any trace, inline | Experiments in the Playground or the SDK | Test suites; online evaluation rules |
| LangSmith | Hand-written examples, traces | Correctness evaluator in our run | Pairwise Experiments |
| Laminar | One click from a span | Your own Python functions, run with `evaluate()` | Labeling queues |
| Langfuse | Hand-written items, traces | Experiments over a dataset | — |
| Phoenix | One click from a span | LLM evaluators and code evaluators | — |
| MLflow | UI or any trace | Built-in LLM judges, custom code judges | — |
| PromptLayer | Tables and Datasets (docs; not tested) | Model-comparison grid | A/B tests on Release Labels |
| AcruxCore | Feedback rows, typed rows, CSV or JSON | LLM judges | Online evaluation rules |
| Helicone | Rows from the Requests page | Not reached | — |

- 👍 **Agenta.** The largest library here. Nine of its 11 types need no model, such as exact match,
  regex and JSON diff. Our auto evaluation over three rows finished in 2.37 seconds with a judge
  score of 66.67%.
- 👍 **Opik.** The widest range. Test suites take cases from a CSV or JSON file as pre-deployment
  regression tests. Online evaluation rules score live traces automatically.
- 👍 **LangSmith.** An Experiment over 5 rows scored 0.80 with a Correctness evaluator, at about
  0.99 s P50 latency. Pairwise Experiments compare two runs side by side.
- 👍 **Laminar.** Code first. You write `evaluate(data=..., executor=..., evaluators={...})` and run it
  locally or in CI. Our run over three cases showed a score beside each row's trace. Your scorers
  can assert anything, but someone has to run them.
- 👍 **Langfuse.** An experiment over a 5-item dataset finished in seconds, for $0.00021 in total.
- 👍 **PromptLayer.** The Evaluate button built a grid that called gpt-4o and gpt-4o-mini on one row,
  with cost and latency columns. Its docs now point to Tables for fixed example sets. We did not
  test Tables.
- 👍 **AcruxCore.** We marked a trace with a thumbs-up and turned that feedback row into a dataset in
  one click. Rule-based online evaluation runs a judge on every matching live trace, like Opik's.
- 👎 **Phoenix.** "Add to Dataset" from a span built a dataset in one step. Our experiment then failed
  with "Dataset is missing input for variables". The dataset held the rendered messages, not the
  template variables.
- 👎 **MLflow.** Built-in judges from an empty start. After we created a dataset, its list page kept
  showing the empty state, though the SDK confirmed the dataset existed.
- **Helicone.** Datasets come from logged requests. Our self-hosted build logged none, so there was
  nothing to test.

<details>
<summary>See the actual screens: evaluation on nine platforms (Helicone had nothing to show)</summary>

**LangSmith** — a real Experiment run: 5 rows scored by a Correctness evaluator:

![LangSmith experiment results grid showing 5 rows with Inputs, Reference Outputs, and generated Outputs columns](/img/tutorials/langsmith-walkthrough/ls-live-03-experiment-results.jpg)

**Langfuse** — a completed experiment run, real cost and latency for the whole dataset:

![Langfuse experiment run row showing completed status, item count, latency, and total cost](/img/tutorials/langfuse-walkthrough/lf-live-03-experiment-result.jpg)

**PromptLayer** — the Model comparison table, calling two real models side by side on one input row:

![PromptLayer model-comparison table showing gpt-4o and gpt-4o-mini outputs side by side](/img/tutorials/promptlayer-walkthrough/10-live-model-comparison-eval.jpg)

**Phoenix** — the LLM/Code evaluator split, and the experiment that failed on a variable-shape mismatch:

![Phoenix's Evaluators overview diagram: Dataset → Task (Playground Prompt) → Evaluator (LLM or Code) → Score](/img/comparison/phoenix/px-12-evaluators-overview.png)
![Phoenix's experiment view over the new dataset — the saved prompt selected, but "Dataset is missing input for variables: company, is_vip, tickets, question" because the dataset stored rendered messages, not template variables](/img/comparison/phoenix/px-11-experiment-run.png)

**Opik** — a dataset-bound experiment run, the Test suites page, and the Online evaluation page:

![Opik's Playground with the dataset loaded, a variant bound to the dataset's message field, and a real experiment result row showing the model's reply next to the dataset's expected output and feedback score](/img/comparison/opik/op-08-experiment-run.png)
![Opik's empty Test suites page, offering Upload a file (CSV/JSON) or Use SDK as the two ways to define test cases with expected outputs and scoring](/img/comparison/opik/op-11-test-suites.png)
![Opik's "No online evaluations yet" empty state under Online evaluation, with "Create a rule to automatically score your model's outputs" and a Create your first rule button](/img/comparison/opik/op-13-online-evaluation.png)

**MLflow** — built-in judges, and the dataset the list page failed to show:

![MLflow's empty Judges page: "Add a judge to your experiment to measure your GenAI app quality," with New LLM judge and New custom code judge buttons](/img/comparison/mlflow/mf-07-judges.png)
![MLflow's vip-support-triage-eval dataset detail page with 2 records, each an Inputs/Expectations pair, tagged with the creating user](/img/comparison/mlflow/mf-06-eval-dataset.png)

**Laminar** — an SDK-run evaluation, its scorer functions visible as spans under the executor:

![Laminar evaluation results for vip-triage-v1: average scores of 1 for both evaluators, three scored rows, and a trace tree with executor and evaluator spans](/img/comparison/laminar/lm-10-evaluation-run.png)

**Agenta** — the LLM judge editor with its test panel, and the finished auto evaluation:

![Agenta's New Evaluator drawer for an LLM-as-a-judge, with a system prompt about grading model outputs, a user message with {{inputs}} and {{outputs}}, the model set to OpenAI GPT-4o-mini, and an empty Test Evaluator panel on the right](/img/comparison/agenta/ag-08-judge-editor.png)
![Agenta evaluation run overview for default-v4-vip-triage-cases: status Success, cost US$0.00, duration 2.37 s, 261 tokens, and a triage-judge score of 66.67%, with a radar chart of score, cost and duration](/img/comparison/agenta/ag-09-eval-run.png)

**AcruxCore** — selecting a real feedback row, then the resulting dataset it built:

![AcruxCore Feedback page with one real feedback row checked, showing 1 feedback row selected and a Create dataset button](/img/tutorials/acruxcore-walkthrough/08-feedback-selected.png)
![AcruxCore Evaluations page listing a real dataset named support-triage-regression with 1 example, created just now](/img/tutorials/acruxcore-walkthrough/09-dataset-created.png)

</details>

## Guardrails and spend controls

:::info[Quick take]
Opik and MLflow block a call for its content. Helicone's docs describe the same for OpenAI models
only (not tested). MLflow and AcruxCore can stop a call over budget. Helicone has rate-limit
rules, which can count cents. Laminar redacts PII from stored traces.
:::

| Tool | Blocks content | Spend cap | Rate limits | PII in stored traces |
|---|---|---|---|---|
| Opik | Yes: PII, Topic, prompt-injection, LLM-judge and custom-classifier guards (per docs; we tested Topic and PII) | No | No | No |
| MLflow | Yes: Safety, PII and custom guardrails | Yes: Budgets page | No | No |
| Helicone | Partial: LLM Security and Moderations, OpenAI models only (per docs, not tested) | Partial: a rate-limit policy counted in cents (per docs) | Yes: Rate Limit Rules, per end user | No |
| Laminar | No | No: not possible beside the path | No | Yes: redacted before storage |
| Agenta | No | No: not on invoke | No: not per key on model calls | No |
| AcruxCore | No | Yes: `402` before the provider call | Yes: per-key RPM and TPM, `429` | Partial: secrets scrubbed; capture can be turned off |
| LangSmith, Langfuse, PromptLayer, Phoenix | No | No | No | No |

- 👍 **Opik.** Five guard types per its docs; we tested the "Set a guardrail" panel. The Topic
  guardrail blocks listed topics, with a sensitivity slider. The PII guardrail flags card numbers, phone numbers and emails, each with
  its own threshold.
- 👍 **MLflow.** The most complete. Each gateway endpoint has a Guardrails tab with Safety, PII and
  custom checks. A separate Budgets page sets a spending window and what happens when it is
  exceeded.
- 👎 **Helicone.** Its docs describe LLM Security and Moderations checks that work with OpenAI
  models only (per docs, not tested). Its Rate Limit Rules builder worked on our build. A rule can
  apply to each end user, and per docs it can count cents instead of requests.
- 👎 **Laminar.** PII redaction, not a guardrail. It removes names, emails and phone numbers from spans
  before storing them. The call itself still goes through.
- 👎 **AcruxCore.** No content guardrail. Spend caps and per-key limits stop the call before the
  provider is called. Traces have API keys, tokens and emails scrubbed, and a team can turn payload
  capture off. Names and phone numbers are not detected.

<details>
<summary>See the actual screens: guardrails, budgets, and rate limits</summary>

![Opik's "Set a guardrail" panel: Topic guardrail and PII guardrail toggles with sensitivity sliders, a restricted personal data checklist (credit card number, phone number checked), and a Python code sample using opik.guardrails](/img/comparison/opik/op-12-guardrails.png)
![MLflow's "Create Guardrail" dialog, showing three options: Safety (detects harmful, offensive, or toxic content), PII Detection (detects names, emails, and phone numbers), and Custom Guardrail](/img/comparison/mlflow/mf-09-guardrail-types.png)
![MLflow's empty Budgets page: "No budget policies created. Set spending limits and control costs across your endpoints," with a Create budget policy button and columns for Reset period, On Exceeded, Window Start/End, and Current Spend](/img/comparison/mlflow/mf-11-budgets.png)
![Helicone's Rate Limit Rules tab: "No rate limits defined yet. Create your first rate limit rule to get started," with a Create Rule button](/img/comparison/helicone/hl-14-rate-limit-rules.png)

</details>

## From feedback to a fixed prompt

:::info[Quick take]
Langfuse and PromptLayer go from a trace to a saved prompt version in three clicks. AcruxCore
also automates the loop from the dashboard. Opik and MLflow have optimizers that run from the SDK.
:::

The question here: once a trace has bad feedback, how much work does it take to ship a better
prompt? We ran this loop on four tools and checked the optimizers of the others in their docs.

| Tool | Trace to Playground to saved version | Automatic rewrite |
|---|---|---|
| AcruxCore | Yes | Yes: Improve from feedback, started in the dashboard |
| Langfuse | Yes, three clicks | No: none in the product |
| PromptLayer | Yes, three clicks | No: none found |
| LangSmith | No: no Playground link on the trace | Partial: Polly rewrites in the Playground, with no dataset or scoring |
| Opik | Not run | Yes: Opik Agent Optimizer, from the SDK |
| MLflow | Not run | Yes: `optimize_prompts()`, experimental, from the SDK |
| Phoenix | Not run | Partial: Prompt Learning, a separate repository |
| Laminar | Partial: trace to playground only, no version to save | No: no prompt registry |

The optimizer column comes from each tool's docs and source, checked on 10 September 2026.

- 👍 **Langfuse.** A generation has a Playground button. It opens with that call's system message and
  model filled in, and **Save as prompt** writes a new version.
- 👍 **PromptLayer.** The same loop: **Open in Playground** from a Request Log entry, then **Save
  Template**.
- 👍 **AcruxCore.** The manual loop works through **Open in Playground** on the LLM span. **Improve from
  feedback** automates it: it builds a dataset from the selected feedback rows and drafts several
  rewrites. It judges each one against the production version and offers **Promote to
  production** on the winner. Our run with 1 feedback row produced 3 candidates. One row is too few
  to rank them, so treat that run as a demonstration of the mechanism.
- 👍 **Opik and MLflow.** Both have real optimizers. Opik's covers more algorithms than ours: MetaPrompt,
  GEPA, evolutionary and few-shot Bayesian search. MLflow's runs DSPy's MIPROv2 or GEPA. Both start
  from a dataset you already have, and neither has a button in the UI.
- 👎 **LangSmith.** The pieces exist (Add feedback, Add to Dataset, Add to Annotation Queue), but no
  link opens the call in the Playground. You rebuild the call by hand.
- 👎 **Laminar.** The trace-to-playground jump works, but there is no prompt version to save back to.
  Laminar's labeling queues let a reviewer work through spans against a defined schema. Agenta has
  annotation queues that work the same way. AcruxCore has trace feedback, but no queue.

<details>
<summary>See the actual screens: feedback → playground → save on all four platforms</summary>

**LangSmith** — feedback exists on the trace, but the action bar has no Playground link:

![LangSmith trace action bar showing Add to, Share, Copy run, and More actions buttons, with an Add feedback control in the Feedback tab and no Playground option](/img/tutorials/comparison/ls-trace-actions.png)

**Langfuse** — the Playground button on a trace generation, then the Playground itself pre-loaded with that exact call:

![Langfuse trace generation panel showing Add to datasets, Annotate, and Playground buttons, with a Fresh playground / Add to existing menu open](/img/tutorials/comparison/lf-playground-menu.png)
![Langfuse Playground pre-loaded with the trace's exact system message and model, with a Save as prompt button](/img/tutorials/comparison/lf-playground-loaded.png)

**PromptLayer** — the same loop from a Request Log entry:

![PromptLayer Request Log page showing Open in Playground, Score N/A, and Add to Table controls above a real chat exchange](/img/tutorials/comparison/pl-request-loop.png)
![PromptLayer Playground pre-loaded from that request, with a Save Template button](/img/tutorials/comparison/pl-playground-save.png)

**AcruxCore** — feedback selected, then the automated Improve-from-feedback run, and the Runs tab where every run lands:

![AcruxCore Feedback page with one feedback row selected and a Create dataset button](/img/tutorials/acruxcore-walkthrough/08-feedback-selected.png)
![AcruxCore Run report leaderboard showing 4 variants (3 drafted candidates plus production) scored 85.0-90.0 against gpt-4o-mini](/img/tutorials/comparison/acx-improve-leaderboard.png)
![AcruxCore candidate detail panel showing judge reasoning, a Passed verdict, and a Promote to production button](/img/tutorials/comparison/acx-improve-promote.png)
![AcruxCore Runs tab listing past evaluation runs with status, score, best variant, and duration columns](/img/tutorials/comparison/acx-runs-tab.png)

</details>

## Developer experience

:::info[Quick take]
Most tools wrap a provider call you still make yourself. MLflow and AcruxCore are gateways your
call goes through. Laminar's setup is the only one written for a coding agent.
:::

| Tool | What your code does |
|---|---|
| LangSmith | `wrap_openai` plus `@traceable` around your OpenAI call |
| Langfuse | Import its drop-in OpenAI wrapper |
| PromptLayer | Use `pl_client.openai` instead of `openai` |
| Opik | `track_openai()` around a client you already have |
| Phoenix | `register()` plus an instrumentor; template logic duplicated in your code |
| Laminar | `Laminar.initialize()` plus `@observe()` |
| Agenta | `ag.init()`, an instrumentor, a decorator and `store_refs()`, or one invoke call |
| MLflow | `load_prompt()`, `start_span()`, then `link_prompt_versions_to_trace()` |
| Helicone | Point the OpenAI client at the gateway base URL; on our install we called the provider and logged by hand |
| AcruxCore | `prompts.render()` plus `gateway.chat()`, in Node or Python |

The wrapper tools look like this:

```python
# LangSmith
client = wrap_openai(OpenAI(api_key=...))

# Langfuse
from langfuse.openai import openai
client = openai.OpenAI(api_key=...)

# PromptLayer
pl_client = PromptLayer(api_key=...)
client = pl_client.openai.OpenAI(api_key=...)

# Opik
client = track_openai(OpenAI(api_key=OPENROUTER_KEY, base_url="https://openrouter.ai/api/v1"))

# Phoenix: instrument once. It has no server-side render, so the Mustache logic
# had to be repeated in Python.
from phoenix.otel import register
from openinference.instrumentation.openai import OpenAIInstrumentor
OpenAIInstrumentor().instrument(tracer_provider=register(endpoint="http://localhost:6006/v1/traces"))

# Laminar: instrument once, and a decorator gives the trace its shape
from lmnr import Laminar, observe
Laminar.initialize(project_api_key=os.environ["LMNR_PROJECT_API_KEY"], base_url="http://localhost:8000")

@observe(name="vip_support_triage")
def triage(message: str) -> str:
    return client.chat.completions.create(model="gpt-4o-mini", messages=[...]).choices[0].message.content

# Agenta: instrument, decorate, then link the trace to the prompt by hand
ag.init()
OpenAIInstrumentor().instrument()

@ag.instrument()
def triage(variables: dict) -> str:
    config = ag.ConfigManager.get_from_registry(app_slug=APP_SLUG, environment_slug="production")
    prompt = PromptTemplate(**config["prompt"]).format(**variables)
    response = client.chat.completions.create(**prompt.to_openai_kwargs())
    ag.tracing.store_refs({"application.slug": APP_SLUG, "environment.slug": "production"})
    return response.choices[0].message.content
```

**MLflow** needs three calls to render, trace and link:

```python
prompt = mlflow.genai.load_prompt("prompts:/vip-support-triage@production")
with mlflow.start_span(name="vip-support-triage-gateway-call") as span:
    resp = requests.post(f"{TRACKING_URI}/gateway/mlflow/v1/chat/completions", json={...})
mlflow.MlflowClient().link_prompt_versions_to_trace(trace_id=span.trace_id, prompt_versions=[prompt])
```

**AcruxCore** renders the stored prompt and routes it through the gateway, with no provider client
in your code:

```javascript
// Node — npm install @acruxcoreai/sdk
const { messages } = await hub.prompts.render('support-triage', 'production', { ... });
const result = await hub.gateway.chat({ model: 'gpt-4o-mini', messages });
```

```python
# Python — pip install acruxcore
rendered = await hub.prompts.render("support-triage", "production", { ... })
result = await hub.gateway.chat("gpt-4o-mini", rendered.messages)
```

- **The biggest friction was keys.** LangSmith, Langfuse and PromptLayer blocked their Playgrounds
  until we added our own provider key, and none of the three ships a trial key. AcruxCore is
  bring-your-own-key too.
- **Laminar's setup targets a coding agent.** Its empty traces page gives you a prompt to paste into
  your agent. `npx lmnr-cli setup` writes a project key and installs a "Laminar skill". With
  `LMNR_DEBUG=1`, an agent can run your agent, read the trace and re-run it with cached state. No
  other tool here has that debugger. AcruxCore has an
  [MCP server](https://docs.acruxcore.com/docs/guides/connect-an-mcp-client) instead: an agent can
  run a stored prompt, read its trace and commit a new version.

:::github
- [`px_trace_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/phoenix-vs-acruxcore/python/px_trace_run.py)
- [`op_trace_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/opik-vs-acruxcore/python/op_trace_run.py)
- [`mlflow_gateway_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/mlflow-vs-acruxcore/python/mlflow_gateway_run.py)
- [`hl_trace_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/helicone-vs-acruxcore/python/hl_trace_run.py)
- [`lm_trace_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/laminar-vs-acruxcore/python/lm_trace_run.py)
- [`ag_trace_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/agenta-vs-acruxcore/python/ag_trace_run.py)
:::

<details>
<summary>See the actual screens: the trace each platform's SDK script produced</summary>

**LangSmith** — `wrap_openai` + `@traceable`, no LangChain required:

![LangSmith trace detail for a script-generated call, showing a nested ChatOpenAI span, token count, and cost](/img/tutorials/langsmith-walkthrough/ls-sdk-01-trace-from-script.jpg)

**Langfuse** — the drop-in OpenAI wrapper, built on OpenTelemetry:

![Langfuse trace detail for a script-generated call, showing cost, latency, and OpenTelemetry SDK metadata](/img/tutorials/langfuse-walkthrough/lf-sdk-01-trace-from-script.jpg)

**PromptLayer** — `pl_client.openai` instead of importing `openai` directly:

![PromptLayer Requests table with the SDK-originated call at the top, showing model and real generated response](/img/tutorials/promptlayer-walkthrough/11-sdk-request-log.jpg)

**Phoenix** — the ticket loop rendering correctly because `tickets` is a real Python list here, unlike the Playground's flat text box:

![Phoenix's trace produced by the SDK script — the system message's ticket loop rendering correctly ("- #4821: ...", "- #4790: ..."), because tickets is a real Python list, not a flat text box](/img/comparison/phoenix/px-09-sdk-trace.png)

**Opik** — the two-level span tree produced by the wrapped client:

![Opik's trace for the script-generated call: 138 total tokens, <$0.01 cost, 2.6s latency, model and provider metadata visible on the span](/img/comparison/opik/op-06-trace-detail.png)

**MLflow** — automatic on the Gateway call, prompt lineage attached by the extra explicit call:

![MLflow's trace detail Linked prompts tab, showing a table with one row: prompt name vip-support-triage, version 3](/img/comparison/mlflow/mf-04-trace-linked-prompt.png)

**Laminar** — the integration grid and the "get started in one prompt" panel aimed at a coding agent:

![Laminar onboarding: a grid of integrations including Vercel AI SDK, Claude Agent SDK, OpenAI Agents SDK, Browser Use and Stagehand, beside a "Get started in one prompt" panel for a coding agent](/img/comparison/laminar/lm-01-onboarding-integrations.png)

**Agenta** — the decorated `triage` span over an `openai.chat` child, with the template variables as inputs:

![Agenta trace produced by the SDK script: a triage workflow span over an openai.chat child, 2.67 s, $0.000053, 166 tokens, with is_vip, company, tickets and customer_message as inputs and the model's reply as output](/img/comparison/agenta/ag-13-sdk-trace.png)

**AcruxCore** — `hub.prompts.render` + `hub.gateway.chat`, one gateway hop, no OpenAI client at all:

![AcruxCore trace detail for a script-generated call, showing the expanded LLM span with Model, Provider, Tokens, Latency, and the real request/response JSON](/img/tutorials/comparison/acx-sdk-trace.png)

</details>

## Tools and tool-calling

:::info[Quick take]
Only AcruxCore treats a tool as a versioned object that it runs and measures. The others show a
tool call as a span or a per-session schema. MLflow lists MCP servers, and Agenta offers
third-party actions.
:::

| Tool | What it has for tools |
|---|---|
| AcruxCore | Versioned Tool Catalog with aliases, runs each tool, analytics per tool |
| MLflow | MCP Registry: a catalog of external MCP servers; runs no tool |
| Agenta | Tool schemas per prompt; Composio actions and MCP servers for agents |
| Laminar | Tool calls as spans; a tool schema stored on a playground row |
| LangSmith | Tool calls as spans |
| Langfuse | A tool schema scoped to one Playground session |
| PromptLayer | A tool-call count per request; a per-session tool schema |
| Phoenix | A JSON Schema per Playground prompt |
| Opik | Only an "Agent playground" that needs a live process |
| Helicone | A prompt version's body takes the OpenAI chat-request shape, which includes `tools` (per Helicone docs and source, not tested) |

- 👍 **AcruxCore.** Tools have their own section in the navigation, with Versions and Aliases tabs, as
  prompts do. A Tool analytics page shows call volume, error rate and P50/P95 latency per tool.
- 👎 **Everyone else.** A tool call shows up in the trace, or a schema lives for one Playground
  session. Nothing persists as a team-wide, versioned tool.
- **MLflow.** The closest to a catalog, built for a different question. Its MCP Registry answers
  "which MCP servers exist?", not "how often does this tool fail?".
- **Agenta.** Agents can use a catalog of third-party Composio actions, which Agenta runs on its
  server. On a self-hosted install the catalog returned HTTP 503 until a Composio key was set.
- **Laminar.** The best view of tool calls as spans. Nothing in Laminar runs a tool. Your agent does,
  and Laminar records it.

<details>
<summary>See the actual screens: tools on the platforms that have a tool page (Helicone, Laminar and Agenta are not shown)</summary>

**LangSmith** — a tool call only ever shows up as a span inside a trace:

![LangSmith trace view showing a lookup_product_docs tool-call span next to a gpt-4o-mini LLM span](/img/tutorials/langsmith-walkthrough/ls-07-trace-span-view.png)

**Langfuse** — a Playground-scoped tool definition, not a persistent catalog:

![Langfuse Playground's Tools panel showing "No tools attached" and a Create new tool button](/img/tutorials/comparison/lf-tools-attach.png)

**PromptLayer** — a Tools & Output control on the same per-request Playground shown earlier:

![PromptLayer Playground toolbar showing a Tools & Output button next to Save Template](/img/tutorials/comparison/pl-playground-save.png)

**Phoenix** — the same live-run Playground screen, its tool control lives inside the message editor, not a separate section:

![Phoenix's Playground with the vip-support-triage prompt loaded, showing Mustache section syntax for the VIP conditional and the tickets loop, tagged "production", with real cost/token/latency telemetry from a live run](/img/comparison/phoenix/px-01-prompt-editor.png)

**Opik** — the Agent playground, sitting disconnected until a live process is wired in by code:

![Opik's Agent playground showing Disconnected status and setup instructions to add @opik.track(entrypoint=True) to a running agent and run a connection command in the terminal](/img/comparison/opik/op-09-agent-playground-connect.png)

**MLflow** — a real, persistent catalog, but of external MCP servers rather than individual tools:

![MLflow's empty MCP Registry page, with a "Create MCP server" button and the description "Register and catalog MCP servers for your organization"](/img/comparison/mlflow/mf-05-mcp-registry.png)

**AcruxCore** — a dedicated, versioned Tool Catalog with its own analytics page:

![AcruxCore Tools page listing the get_weather tool with a description and creation date](/img/tutorials/comparison/acx-tools-catalog.png)
![AcruxCore tool detail page showing Versions and Aliases tabs, identical to the prompt versioning model](/img/tutorials/comparison/acx-tools-versions.png)
![AcruxCore Tool analytics page showing call volume, error rate, and P50/P95 latency for get_weather](/img/tutorials/comparison/acx-tools-analytics.png)

</details>

## Pricing and self-hosting

:::info[Quick take]
Every tool has a free option. Seven are open source and free to self-host. LangSmith and
PromptLayer self-host only on Enterprise plans.
:::

All prices were checked on 2 November 2026. Server sizes come from
[Self-hosting LLM observability tools](https://acruxcore.com/blog/self-hosting-llm-observability).

| Tool | Free hosted tier | Lowest paid plan | Self-host | Server |
|---|---|---|---|---|
| LangSmith | 1 seat, 5k base traces a month | $39 per seat a month, 10k traces | Enterprise only | — |
| Langfuse | 50k units a month | $29 a month, 100k units | Free, MIT (except `ee` folders) | 4 GB |
| PromptLayer | 2.5k requests a month | $49 a month | Enterprise only | — |
| Phoenix | Arize AX, 25k spans a month | Arize AX Pro, $50 a month | Free, Elastic License 2.0 | 1 GB |
| Opik | 25k spans a month | $19 a month, 100k spans | Free, Apache 2.0 | 8 GB |
| MLflow | — | No paid plan | Free, Apache 2.0 | 4 GB |
| Helicone | 10,000 requests | $79 a month | Free, Apache 2.0 | — |
| Laminar | 1 GB of data, 7 days | $30 a month, 3 GB | Free, Apache 2.0 | 2 GB |
| Agenta | Hobby, $0 | $29 a month | Free, MIT | 4 GB |
| AcruxCore | The hosted platform is free to use | No paid plan | Free, Apache 2.0 | 1 GB |

- **Phoenix's licence is source-available.** Elastic License 2.0 lets you self-host for free, but
  it is not an open source licence.
- **Usage pricing differs.** Langfuse charges $8 per extra 100k units up to 1 million units, and
  less above that. Opik charges $5 per extra 100k spans.
- **Audit logs sit on top plans.** Langfuse's audit log is on Enterprise ($2,499 a month), on hosted
  Langfuse too. Agenta's is Enterprise only.
- **Helicone's status is changing.** Mintlify acquired Helicone in March 2026 and put it in
  maintenance mode. On 2 November 2026, Helicone's site said it is no longer part of Mintlify, with
  details to come. [AcruxCore vs Helicone](https://acruxcore.com/blog/acruxcore-vs-helicone)
  has the dates.
- **Agenta's focus has moved.** Its README now leads with an agent builder. The docs for its prompt,
  evaluation and tracing features are marked as no longer actively maintained, though those
  features still ship.

## Features only one tool has

These are features we found on one tool only, not a different button for the same idea.

| Tool | Only here |
|---|---|
| LangSmith | Studio for LangGraph agents; Pairwise Experiments |
| Langfuse | Prompt references; session and user badges on the trace header |
| PromptLayer | A/B tests on live traffic by Release Label |
| Phoenix | PXI, a chat assistant that answers questions about your traces; retention per project |
| Opik | Test suites for pre-deployment regression testing |
| MLflow | Guardrails and Budgets on every gateway endpoint; an MCP server registry |
| Helicone | Rate limits per end user or custom property: one policy header, plus the user-id or property header |
| Laminar | SQL over spans in the free self-hosted build; `LMNR_DEBUG`; browser-agent session recording |
| Agenta | 11 evaluator types plus five regex presets, including a webhook; webhooks on deploy; variants of one prompt |
| AcruxCore | Versioned Tool Catalog; Improve from feedback from the dashboard; datasets from feedback rows |

**Laminar's Signals need a note.** You describe a behaviour in plain English, and an LLM watches
traces for it. After we enabled Signals and ran a trace, no event appeared within our observation
window.

## Braintrust, Datadog and W&B Weave

These three are not part of the ten-tool run.

- **Braintrust.** Tested separately on its hosted Starter tier, in
  [AcruxCore vs Braintrust](https://acruxcore.com/blog/acruxcore-vs-braintrust). It is built around
  evaluation against datasets. `braintrust eval` compares each run with the
  previous one by default, and a SQL sandbox queried our experiment in 0.41 s. Starter is $0 a
  month. Pro is $249 a month, and self-hosting is Enterprise only.
- **Datadog LLM Observability.** Not tested by us. Its docs describe LLM traces next to the rest of
  your Datadog data, PII redaction and prompt-injection flags. A free tier covers 40K LLM spans a
  month, and Pro starts at $160 a month.
- **W&B Weave.** Not tested by us. `@weave.op` traces any function, and evaluations use LLM judges
  and custom scorers. Free includes 1 GB a month, and Pro starts at $60 a month.

## Where AcruxCore stands

**Matches.** Immutable versions with a movable pointer and a Diff tab, like most of the field.
Span-based tracing on par with LangSmith, Langfuse, Phoenix and MLflow, behind Laminar.

**Ahead.**

1. 👍 **Tool Catalog.** The only tool here that versions your tools, runs them and measures each call.
2. 👍 **Improve from feedback.** A rewrite loop that starts from a person marking an answer wrong,
   run from the dashboard. Opik and MLflow have stronger optimizers, but only from the SDK.
3. 👍 **In the request path.** Tracing, cost, budgets and caching come with the call itself. MLflow
   shares this design, and its gateway measured +135 to +225 ms against our +4 to +51 ms.
4. 👍 **Audit trail.** A team-wide log of 34 event types, on from the day a workspace exists.
   Langfuse and Agenta keep theirs on Enterprise. We found none on Phoenix, Opik, MLflow,
   Helicone or Laminar. It has no export and no retention setting yet.

**Behind.**

1. 👎 **Content guardrails.** Opik and MLflow have them. We have none.
2. 👎 **Evaluation tooling.** No pairwise experiments (LangSmith), test suites (Opik) or server-side
   rule evaluators (Agenta). No annotation queues (Laminar, Agenta).
3. 👎 **Questions about your own traces.** Laminar has SQL over spans and a dashboard builder. Our
   analytics page groups by one of day, model, session or prompt version.

**Worth adopting.**

- Laminar's SQL editor. A fixed analytics page answers the questions we thought of. A query box
  answers the questions the user thinks of.
- Opik's or MLflow's guardrails, which would close our largest gap.
- Opik's GEPA and evolutionary search, which do more than our single rewrite pass.
- Agenta's rule evaluators, so a check that needs no model runs without the SDK.
- PromptLayer's model-comparison grid, so a new account can evaluate without a dataset.
- LangSmith's pairwise view, once accounts have several runs to compare.

## FAQ

### What are LLM observability tools?

They record each model call as a trace with the prompt, the response, the tokens, the cost and
the latency. For an agent, one trace holds every model call and tool call of a run as nested
spans. Most of these tools also store prompt versions and run evaluations.

### Which LLM observability tools are open source?

Langfuse (MIT, except the `ee` folders), Opik, MLflow, Helicone, Laminar and AcruxCore (Apache
2.0) and Agenta (MIT) are open source and free to self-host. Phoenix is free to self-host under
the Elastic License 2.0, which is source-available. LangSmith, PromptLayer and Braintrust offer
self-hosting on Enterprise plans only.

### Do LLM observability tools add latency?

The SDK tools we timed, Phoenix, Opik and Laminar, added tens of milliseconds at most to a call of
about 600 ms. MLflow's AI Gateway added +135 to +225 ms in our runs. AcruxCore's gateway added +4
to +51 ms across 15 runs.

### Which LLM observability tool is best for AI agents?

In our tests, Laminar had the deepest agent traces, with nested spans, tree and transcript views,
and SQL over the spans. LangSmith suits teams that build on LangGraph.

### Is there a free LLM observability tool?

Every tool here has a free option. The open source tools are free to self-host, and most have a
free hosted tier. The hosted AcruxCore platform is free to use.

## Further reading

Each tool has its own full post with every screen and script:

- [Hands-on with LangSmith](https://acruxcore.com/blog/langsmith-hands-on-walkthrough)
- [Hands-on with Langfuse](https://acruxcore.com/blog/langfuse-hands-on-walkthrough)
- [A hands-on walkthrough of PromptLayer](https://acruxcore.com/blog/promptlayer-hands-on-walkthrough)
- [AcruxCore vs Arize Phoenix](https://acruxcore.com/blog/acruxcore-vs-phoenix)
- [AcruxCore vs Opik](https://acruxcore.com/blog/acruxcore-vs-opik)
- [AcruxCore vs MLflow](https://acruxcore.com/blog/acruxcore-vs-mlflow)
- [AcruxCore vs Helicone](https://acruxcore.com/blog/acruxcore-vs-helicone)
- [AcruxCore vs Laminar](https://acruxcore.com/blog/acruxcore-vs-laminar)
- [AcruxCore vs Agenta](https://acruxcore.com/blog/acruxcore-vs-agenta)
- [AcruxCore vs Braintrust](https://acruxcore.com/blog/acruxcore-vs-braintrust)

Posts that compare several tools at once:

- [Langfuse vs LangSmith](https://acruxcore.com/blog/langfuse-vs-langsmith): one app run end to end on both.
- [AcruxCore vs Langfuse vs LangSmith](https://acruxcore.com/blog/acruxcore-vs-langfuse-vs-langsmith): the same app on all three.
- [LangSmith alternatives](https://acruxcore.com/blog/langsmith-alternatives) and
  [Langfuse alternatives](https://acruxcore.com/blog/langfuse-alternatives): licence,
  self-hosting, price and features.
- [Self-hosting LLM observability tools](https://acruxcore.com/blog/self-hosting-llm-observability):
  memory and disk for seven self-hosted stacks.

The [AcruxCore Quickstart](https://docs.acruxcore.com/docs/getting-started/quickstart) goes from
sign-up to a traced call through the gateway.
