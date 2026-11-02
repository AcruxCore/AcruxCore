---
title: "AcruxCore vs Laminar: SQL over traces vs a prompt gateway"
description: "AcruxCore vs Laminar: SQL over agent traces, dashboards and labeling queues against prompt versions and a gateway that enforces spend caps."
slug: acruxcore-vs-laminar
date: 2026-09-06
authors: [acrux]
tags: [llmops-comparison, llm-tracing, llm-latency]
image: /img/blog/acruxcore-vs-laminar/header.webp
keywords: [AcruxCore vs laminar, laminar vs AcruxCore, llm ops comparison, agent observability, sql over traces, opentelemetry llm tracing]
last_update:
  date: 2026-11-02
---

![Laminar starts at the trace with SQL over spans, custom dashboards, labeling queues and transcript views; AcruxCore starts at the prompt with prompt versions and aliases, templates, spend caps and a tool catalog](/img/blog/acruxcore-vs-laminar/header.webp)

Laminar (`lmnr`) describes itself as an "open-source observability platform purpose-built for
AI agents", and its GitHub page lists it as a Y Combinator S24 company (checked on 2 November
2026).

The short answer: both show an agent run as a tree of nested spans. Laminar is stronger at
analysing those runs, with SQL over spans, custom dashboards and labeling queues. AcruxCore covers what happens before the call: prompt
versions and aliases, and a gateway that can refuse a call over budget. The two can run
together.

Laminar is built from a Rust ingest server, ClickHouse for spans, Quickwit for search, and an
OpenTelemetry SDK. Its integrations page lists 31 integrations, from LLM SDKs and agent
frameworks to coding agents and browser agents (checked on 2 November 2026). In the build we
ran, its project sidebar had dashboards, traces, evaluations, datasets, labeling, a SQL editor,
playgrounds, a debugger and settings, and no prompt store that your code fetches at runtime. Both projects are
Apache 2.0.

AcruxCore is our product. We ran both platforms on one prompt, and every script is linked.

<!-- truncate -->

## How we tested

- **Prompt:** `vip-support-triage`, a support agent that changes tone for VIP customers and
  lists their open tickets, with the same customer message on both platforms.
- **Model:** both SDK runs call `gpt-4o-mini` on OpenAI, so the generated text is comparable.
  Laminar's playground was set up with a direct OpenAI key and run, so its screenshot shows a
  completion.
- **Laminar:** the self-hosted "lite" stack from `docker compose up -d`, at repo commit
  `f0d19c93` (30 August 2026), served at `http://localhost:5667`. AcruxCore ran locally, with
  its API at `http://localhost:3001`.
- **Dates:** hands-on steps and screenshots on 6 September 2026. Latency from three benchmark
  runs committed on 7 September 2026.
- **Latency:** the benchmark uses SDK paths on all three legs, and every leg ends at
  `api.openai.com`. Hardware not recorded.

### At a glance

| Aspect | Laminar | AcruxCore |
|---|---|---|
| Tracing an agent run | OTel-native, nested spans, tree and transcript views, cost heatmap, 31 integrations listed | Nested OTel spans on an OTLP receiver, five frameworks from one `register()` call, plus an automatic gateway span carrying prompt-version lineage |
| Where the platform sits | Beside the request path, on purpose — works with any provider, no proxy to configure | In the request path — routing, caching, budgets and virtual keys apply before the provider |
| Querying your trace data | Real SQL editor over spans, plus a drag-and-drop custom dashboard builder | Fixed analytics page, four `group_by` options, nothing composable |
| Prompt authoring and versioning | No prompt store your code fetches; in our run a playground held one set of messages, with no aliases or template variables | Immutable versions, `production`/`staging` aliases, a diff tab, `{% if %}` and `{% for %}` |
| Sending a live call | In the build we ran, the playground called seven named providers and showed tokens without cost | Any OpenAI-compatible provider, with cost, cache and latency shown inline |
| How tools are handled | Tool schemas are a JSONB field on a playground row; tool calls show up as spans | Versioned Tool Catalog that the gateway actually executes, with its own analytics |
| Evaluation and datasets | Code-first: your data, your executor, your scorers, run locally or in CI | Server-side runs, LLM judges, plus sampled rules that score live production spans |
| SDK and developer experience | One line auto-instruments your client; a CLI and skill onboard a coding agent | Fetch a stored prompt and send it through the gateway with no tracing code, or one `register()` call to instrument a framework |
| MCP server | [Hosted, three read-only tools](https://laminar.sh/docs/platform/mcp): run SQL over spans, fetch one trace's context, ask a built-in agent | [Hosted or local](https://docs.acruxcore.com/docs/guides/connect-an-mcp-client): read and commit prompts, promote an alias, run a stored prompt, read traces, run experiments |

- **Pick Laminar if** you are shipping an agent on a framework, and your hard problem is
  understanding its behaviour.
- **Pick AcruxCore if** your prompts change often, several people edit them, and cost or
  access needs a control point.

## Tracing an agent run

This is what Laminar is for, so it goes first. `Laminar.initialize()` patches the OpenAI client
through OpenTelemetry, and an `@observe()` decorator nests the model call underneath a parent
span — so the run's *shape* lands in the trace, not just the call.

```python
from lmnr import Laminar, observe

Laminar.initialize(project_api_key=os.environ["LMNR_PROJECT_API_KEY"], base_url="http://localhost:8000")

@observe(name="vip_support_triage")
def triage(message: str) -> str:
    return client.chat.completions.create(model="gpt-4o-mini", messages=[...]).choices[0].message.content
```

The span view carries the full system and user messages, token counts, cost, and an "Experiment
in playground" button that lifts the call straight into their playground.

<details>
<summary>Show screenshot: Laminar span detail with the LLM messages</summary>

![Laminar span detail: a tree with vip_support_triage above an openai.chat child, and a right panel showing System, User and Assistant messages with 158 tokens and $0.0001](/img/comparison/laminar/lm-04-span-llm-messages.png)

</details>

AcruxCore has two ways in. The gateway writes a span server-side, with no tracing code in the
script at all, and links it back to the prompt version that produced it.

<details>
<summary>Show screenshot: AcruxCore trace detail</summary>

![AcruxCore trace detail: a single LLM span with token counts, cost, and a link to the prompt version that produced it](/img/comparison/acruxcore/acx-05-trace-detail.png)

</details>

For the run's *shape* there is an OTLP/HTTP receiver — `POST /api/v1/traces/otlp`, protobuf or
JSON, gzip accepted — that takes nested OTel spans from your process, the same way Laminar's
does. Both SDKs collapse the provider, processor and exporter wiring into one `register()` call,
which can also switch on a framework's own OpenInference instrumentor:

```python
from acruxcore.otel import register

register(api_key=KEY, base_url=BASE_URL, instrument=["crewai", "openai"])
```

Five frameworks are named today — OpenAI, OpenAI Agents SDK, CrewAI, LangChain and LlamaIndex —
and any other OTel or OpenInference instrumentor can be wired to the same provider by hand. A
CrewAI crew traced this way arrives as a real tree: a `Crew.kickoff` root, one agent span per
crew member, with tool and LLM spans nested underneath.

<details>
<summary>Show screenshot: AcruxCore trace tree from a CrewAI crew</summary>

![AcruxCore trace tree from a CrewAI crew: a Crew.kickoff chain root, an agent span for Destination Researcher containing an LLM span and three Tavily Search tool spans, then a sibling agent span for Itinerary Planner](/img/tutorials/trace-a-crewai-trip-planner/03-trace-tree.png)

</details>

So the difference is breadth and reading, not whether the run is visible. Laminar lists 31
integrations and reads a run back as a transcript, a cost heatmap and a realtime feed.
AcruxCore names five frameworks and shows a span tree with a latency waterfall. Its gateway
span carries prompt-version lineage and is written even when the caller sends no spans.

| Feature | Laminar | AcruxCore |
|---|---|---|
| Span source | Your process, via OpenTelemetry | The gateway server-side, or your process over OTLP |
| Code needed to get a trace | One `initialize()` call, plus decorators for structure | None for a gateway call; one `register()` for a framework |
| Nested agent structure | Yes, arbitrary depth | Yes, arbitrary depth, over the OTLP receiver |
| Prompt-version lineage on the span | No: no stored prompt to link to | Yes: from the gateway call |
| Views | Tree, transcript, cost heatmap, realtime | Span tree with a latency waterfall, payloads per span |
| Framework integrations | 31 listed, including Vercel AI SDK, Claude Agent SDK, Browser Use, Stagehand, Mastra, Pydantic AI | 5 via `register()`, plus any OTel instrumentor wired by hand |

## Where Laminar sits: beside the call

Laminar sits beside the request path. Its Rust `app-server` receives spans; it never receives
your model call. We checked the server's routes: the only `/chat/completions` handling in the
codebase is its *outbound* client for its own AI features, not an inbound proxy.

That is a real design choice with real advantages. Any provider works immediately, there is no
proxy to configure or keep up, and nothing Laminar does can fail your production call. The cost
is that a budget, a cache hit or a virtual key has no call to act on — by the time Laminar sees
the request, the money is already spent.

AcruxCore takes the other side. The call goes through us first, which is what makes a spend cap
enforceable: `reserveBudgets()` runs before the provider is contacted and returns
`402 BUDGET_EXCEEDED`, and a per-virtual-key RPM/TPM limit returns `429 RATE_LIMITED` on the same
pre-call path. The cost is the hop, measured in the next section, and the fact that we have to
support your provider.

| Feature | Laminar | AcruxCore |
|---|---|---|
| Position | Beside the request path | In the request path |
| Works with any provider, unmodified | Yes | Partial: only providers the gateway supports |
| Can enforce a spend cap before the call | No | Yes, `402 BUDGET_EXCEEDED` |
| Can rate-limit a key before the call | No | Yes, `429 RATE_LIMITED`, per virtual key |
| Can serve a cached response | No | Yes |
| A platform outage breaks your calls | No | Yes, unless you fail open |

## Latency overhead — measured

Laminar's leg is the OpenAI client instrumented by `Laminar.initialize()`. AcruxCore's leg is
the call through the local gateway. Both were timed against a direct call to `gpt-4o-mini` on
`api.openai.com`, in 100 interleaved rounds per run, over three runs.

| Run | Direct-call median | Laminar gap | AcruxCore gap |
|---|---|---|---|
| 1 | 623 ms | −8 ms, CI [−27, +6] | +7 ms, CI [−12, +22] |
| 2 | 603 ms | +18 ms, CI [+2, +46] | +27 ms, CI [+11, +50] |
| 3 | 643 ms | −4 ms, CI [−28, +15] | +7 ms, CI [−19, +29] |

- Laminar's median gap was −8 to +18 ms, and AcruxCore's was +7 to +27 ms.
- In runs 1 and 3 every interval crosses zero, so neither path can be told apart from a direct
  call in those runs.
- Laminar's median gap was the lower of the two in each run, by 9 to 15 ms. The intervals
  overlap, so three runs do not show that difference is stable.

The two are different kinds of cost. Laminar's is client-side instrumentation that batches
spans off the hot path. AcruxCore's is an extra network hop that pays for routing, budget
checks, virtual keys and caching. Our newest measurement of a local AcruxCore gateway on its own, on
25 October 2026, found a median of +9 ms against a direct OpenAI call, with a 95% interval of
−15 to +28 ms ([method](/blog/llm-gateway-overhead)).

:::github
[`latency_bench.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/laminar-vs-acruxcore/python/latency_bench.py) — the latency benchmark.
:::

## Querying your trace data

Laminar's SQL editor is the feature we most wish we had. It is not a filter builder — it is SQL
over the ClickHouse span store, with table, JSON and chart output, saved queries, an "Ask AI"
button that writes the query for you, and CSV export.

<details>
<summary>Show screenshot: Laminar SQL editor</summary>

![Laminar SQL editor running SELECT name, model, input_tokens, output_tokens, total_cost, duration FROM spans, returning the openai.chat and vip_support_triage rows](/img/comparison/laminar/lm-06-sql-editor.png)

</details>

The dashboard is composable in the same spirit: drag-and-drop cards, resizable, each one backed
by a metric or a custom SQL query. After the benchmark run it had 135 spans to chart.

<details>
<summary>Show screenshot: Laminar dashboards</summary>

![Laminar dashboards page with twelve resizable cards — top spans, top model cost, latency by model p90, trace status, total tokens and total cost](/img/comparison/laminar/lm-09-dashboards.png)

</details>

AcruxCore has neither. Our analytics page groups by exactly one of `day`, `model`, `session` or
`prompt_version` and renders a fixed set of tiles and charts; the state lives in the URL, so you
can share a view as a link, but you cannot compose one. There is no way to ask our trace store an
arbitrary question.

| Feature | Laminar | AcruxCore |
|---|---|---|
| Ad-hoc SQL over spans | Yes, with saved queries and CSV export | No |
| AI-written queries | Yes | No |
| Custom dashboard panels | Yes, drag-and-drop, SQL-backed | No, fixed charts |
| Grouping options | Anything SQL expresses | `day`, `model`, `session`, `prompt_version` |

## Prompt authoring and versioning

Here the shapes differ most. In the build we ran, Laminar had no prompt registry. We checked the
database schema rather than only the sidebar, and there was no prompts table. The nearest thing is
`playgrounds`, one row per playground holding `prompt_messages` as a mutable JSONB blob. Editing
it overwrote it, with no version numbers, no aliases, no diff and no template variables. The
only templating dependency, `mustache`, rendered span previews, not prompts.

Laminar's current docs have no prompt-management page either (checked on 2 November 2026). Two
related features exist. The playground docs say you can "save versions to revisit later". And
since August 2026 the open-source server has an optional system-prompt versioning pipeline, off
by default, that groups the system prompts it sees in traces into versions
([PR #2200](https://github.com/lmnr-ai/lmnr/pull/2200)). We did not test either. Neither one
stores a prompt that your code fetches at runtime.

So the fixture prompt had to be flattened by hand for Laminar — the `{% if is_vip %}`
branch resolved to its VIP text, and the `{% for ticket in tickets %}` loop
expanded into a literal list of two tickets. That flattened string is what `lm_trace_run.py`
inlines, because there is nothing on the platform to fetch it from.

On AcruxCore the same prompt is three immutable versions with `production` and `staging`
aliases, a unified diff between any two, and the conditionals and loop rendered by nunjucks at
request time.

<details>
<summary>Show screenshot: AcruxCore Versions tab with aliases</summary>

![AcruxCore's Versions tab for vip-support-triage: v1, v2 and v3, each with a View traces link, production and staging alias badges on v3, and promote buttons on the older versions](/img/comparison/acruxcore/acx-02-versions-promoted.png)

</details>

| Feature | Laminar | AcruxCore |
|---|---|---|
| Prompt store fetched at runtime | None | Supported |
| Version history | Playground docs say you can "save versions to revisit later"; in our run, editing a playground overwrote its row | Immutable, numbered |
| Environment aliases | None | `production`, `staging`, promotable |
| Diff between versions | None | Unified diff, any two versions |
| Template logic | None in the playground we ran | `{% if %}`, `{% for %}`, filters |
| Runtime "render this stored prompt" call | None | `prompts.render(name, alias, variables)` |

## Sending a live call

Laminar's playground stores messages, a model, tools and an output schema, and can be opened
directly from a traced span — a genuinely nice loop for debugging a call you just saw. It needs
a provider key saved in project settings first, and that page offers a fixed list: OpenAI,
Gemini, Groq, Anthropic, Mistral, Azure and Bedrock, with no field for a custom base URL. We
confirmed the list in their source (`MODEL_PROVIDER_TO_API_KEYS` in
`frontend/lib/env/utils.ts`); keys are stored encrypted per project rather than read from the
environment.

With an OpenAI key saved, it runs. Below is the flattened prompt returning a real completion on
GPT-4o mini. Two things to notice. The messages are typed in flat, because a playground row has
no variables — the VIP sentence and the ticket list are pre-rendered by hand, the same
flattening described above. And the footer reports **input, output and total tokens, but no
cost** — no latency and no cache status either.

<details>
<summary>Show screenshot: Laminar playground run</summary>

![Laminar playground running the flattened vip-support-triage prompt on GPT-4o mini, with the completion in the Output pane and a footer reading Input Tokens 99, Output Tokens 50, Total Tokens 149](/img/comparison/laminar/lm-05-playground-run.png)

</details>

In that build, the provider list was the larger limit: seven named vendors and no custom base
URL, so the playground could not call your own gateway, a relay or a local model server.
Laminar's current playground docs say models come from "LLM profiles" and that the History tab
shows "latency, tokens, cost" for each run (checked on 2 November 2026). We have not re-tested
the playground since 6 September 2026.

AcruxCore's playground runs the stored prompt against any model the gateway knows, and shows cost,
cache status and latency inline with the response.

| Feature | Laminar | AcruxCore |
|---|---|---|
| Runs a stored prompt | No: no stored prompts to run | Yes, by name and alias |
| Provider choice | Seven named providers, no custom base URL, in the build we ran | Any OpenAI-compatible provider |
| Variables in the playground | No — messages are typed in flat | `{{ }}` filled from a variables panel |
| Tokens shown inline | Yes — input, output, total | Yes |
| Cost shown inline | No, in the build we ran | Yes |
| Cache status shown inline | No: no cache | Yes |
| Open from a trace span | Yes, "Experiment in playground" | Re-run from the trace |

## How tools are handled

Laminar records tool calls as spans and stores a tool schema as a `tools` JSONB field on a
playground row. There is no tool catalog page, no version history for a tool, and nothing in
Laminar executes one — your agent does, and Laminar watches. That is consistent with sitting
beside the request path.

AcruxCore's Tool Catalog is the opposite: a tool is a first-class, versioned resource that the
gateway itself calls, with a page measuring per-tool volume, error rate and P50/P95.

| Feature | Laminar | AcruxCore |
|---|---|---|
| Tool definitions stored | JSONB field on a playground row | First-class versioned resource |
| Tool executed by the platform | No | Yes |
| Per-tool analytics | No | Yes |
| Tool calls visible in traces | Yes, as spans | Yes, as spans |

## Evaluation and datasets

Laminar's evaluations are unopinionated and code-first: you supply the data, an executor function
and scorer functions, and it runs them locally or in CI, tracing every call and tracking scores
across runs. We ran one over three triage cases.

```python
evaluate(
    data=DATA,
    executor=executor,
    evaluators={"mentions_topic": mentions_topic, "under_five_sentences": under_five_sentences},
    name="vip-triage-v1", group_name="triage",
)
```

The results view puts the per-row scores beside the trace of each datapoint, with the evaluator
functions themselves showing up as spans under the executor.

<details>
<summary>Show screenshot: Laminar evaluation results</summary>

![Laminar evaluation results for vip-triage-v1: average scores of 1 for both evaluators, three scored rows, and a trace tree with executor and evaluator spans](/img/comparison/laminar/lm-10-evaluation-run.png)

</details>

Datasets are built from the traces you already have — "Add to dataset" on a span turns it into a
Data/Target row with no manual copying.

<details>
<summary>Show screenshot: Laminar dataset built from a span</summary>

![Laminar dataset vip-triage-cases holding one datapoint, its Data column the system and user messages and its Target column the assistant response, both taken from the span](/img/comparison/laminar/lm-07-dataset-from-span.png)

</details>

AcruxCore runs evaluations server-side instead — datasets, LLM judges and experiment runs from the
dashboard, plus **rules** that score live production spans automatically. A rule is plain-English
criteria plus a judge model, matched against incoming `llm` spans by prompt, alias, model or tags,
sampled (10% by default) and capped at a daily limit, producing a 0–100 score with a reason and
emailing owners when a score drops below a threshold.

The difference: Laminar's scorers are arbitrary code and can assert anything, but somebody
has to run them. Ours run themselves against real traffic, but they are LLM judges producing a
sampled numeric score, not arbitrary assertions.

| Feature | Laminar | AcruxCore |
|---|---|---|
| Where an eval runs | Your machine or CI, via SDK/CLI | Server-side, from the dashboard |
| Scorer definition | Any Python function | LLM judge with plain-English criteria |
| Define an eval in the UI | No | Yes |
| Scoring live production traffic | Signals, separately | Yes, sampled rules with alerts |
| Dataset from a trace | Yes, one click from a span | Yes |
| Compare two runs | Yes, side by side | Yes, run history |

## SDK and developer experience

Laminar's onboarding is built for coding agents. The empty traces page hands you
a prompt to paste into your coding agent; `npx lmnr-cli setup` authenticates, writes a project key
to `.env` and installs a "Laminar skill"; and the CLI can query your traces in SQL so the agent
can verify its own instrumentation.

<details>
<summary>Show screenshot: Laminar onboarding integrations</summary>

![Laminar onboarding: a grid of integrations including Vercel AI SDK, Claude Agent SDK, OpenAI Agents SDK, Browser Use and Stagehand, beside a "Get started in one prompt" panel for a coding agent](/img/comparison/laminar/lm-01-onboarding-integrations.png)

</details>

AcruxCore's SDK is aimed at a different job — the prompt lives on the platform, so the script
fetches and fills it, sends it through the gateway, and never mentions tracing:

```python
async with AcruxCore(api_key=KEY, base_url=BASE_URL) as hub:
    rendered = await hub.prompts.render("vip-support-triage", "production", VARIABLES)
    result = await hub.gateway.chat(rendered.model, rendered.messages, prompt_version_id=rendered.version_id)
```

:::github
- [`lm_trace_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/laminar-vs-acruxcore/python/lm_trace_run.py) — the Laminar run.
- [`acx_sdk_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/laminar-vs-acruxcore/python/acx_sdk_run.py) — the AcruxCore run.
:::

| Feature | Laminar | AcruxCore |
|---|---|---|
| Lines to start tracing | One `initialize()` | Zero for a gateway call, one `register()` for a framework |
| Framework auto-instrumentation | 31 integrations listed | 5 — OpenAI, OpenAI Agents SDK, CrewAI, LangChain, LlamaIndex |
| CLI | Yes, including SQL over traces | No |
| MCP access for a coding agent | Yes, read-only | Yes, reads and writes |
| Fetch a stored prompt at runtime | No: no prompts to fetch | Yes |

Both MCP servers let a coding agent read your traces. Through Laminar's server, a coding agent can
also run SQL over your spans. AcruxCore's server has no SQL tool. Through AcruxCore's server, a
coding agent can commit a prompt version, promote an alias and run the stored prompt through the
gateway. Laminar's server is read-only, so a coding agent cannot change anything in Laminar through
it.

## What Laminar does that AcruxCore doesn't

The two biggest ones — SQL over spans and the custom dashboard builder — have their own section
above. Four more, each checked against our own codebase before being written down.

**Labeling queues.** A span can be pushed into a named queue where a reviewer works items one at a
time against a defined annotation schema, then pushes the labelled result to a dataset. AcruxCore
has trace feedback — a human can score a trace from −1 to 5 with a label and comment — but there
is no queue: no assignment to a reviewer, no next-unlabelled-item workflow, no rubric, no
completion tracking.

<details>
<summary>Show screenshot: Laminar labeling queue</summary>

![Laminar labeling queue triage-quality-review with one item, showing the Data panel from the span, a Target panel and an annotation schema](/img/comparison/laminar/lm-08-labeling-queue.png)

</details>

**Signals.** You describe a behaviour in plain English, give it a structured output schema, and an
LLM watches traces for it — with templates for failure, logic, task, user friction, hallucination
and intent, a trigger on trace or span completion, filters, and sampling. Matching events are
grouped into clusters. Laminar's README says it "pings you in Slack" when a matching behaviour
happens (checked on 2 November 2026).

<details>
<summary>Show screenshot: Laminar Create Signal panel</summary>

![Laminar's Create Signal panel: name, six behaviour templates, a prompt, a structured output schema, trigger options, filters and a sampling toggle](/img/comparison/laminar/lm-11-signal-builder.png)

</details>

AcruxCore's online evaluation rules cover much of the
same ground — plain-English criteria, an LLM judge, automatic matching against live spans,
sampling, daily caps and email alerts — so this is *not* a capability we lack. What we lack is the
event-and-cluster model on top: their output is a structured event that gets clustered into
behavioural patterns, ours is a 0–100 score with a reason. On the lite
self-hosted stack, after enabling Signals and running a fresh trace through it, **no event was
produced within our observation window**. The builder is real and we screenshotted it; the
end-to-end result we could not confirm.

**The debugger.** `LMNR_DEBUG=1` lets a coding agent run your agent, read the resulting trace,
change the code and re-run with cached state — the iteration loop owned by the agent rather than
by you. AcruxCore has nothing equivalent. AcruxCore's MCP server lets a coding agent read a trace
and run a stored prompt, but that server cannot re-run your agent with cached state.

<details>
<summary>Show screenshot: Laminar debugger sessions</summary>

![Laminar debugger sessions page explaining the LMNR_DEBUG=1 loop where a coding agent runs, inspects and re-runs your agent with cached state](/img/comparison/laminar/lm-13-debugger.png)

</details>

**PII redaction.** A project-level toggle runs every ingested span through a PII redactor before
storage, replacing detected names, emails and phone numbers. AcruxCore always scrubs a fixed set
of secret patterns — API keys, bearer tokens, AWS access keys and email addresses — and has a
team-level switch to stop capturing payloads at all, but nothing that detects names, phone
numbers or addresses.

Two more without a screenshot. Laminar sends alerts to **Slack**, while AcruxCore's only
notification channel is email. And Laminar records
**browser-agent sessions** for Browser Use, Stagehand and Playwright, which we have no answer for
at all. Our "Sessions" means traces grouped by a caller-supplied session id — a conversation
thread, not a recording.

## Is AcruxCore a Laminar alternative?

For seeing an agent run, yes. Both products take nested OTel spans and show the run as a tree.
For analysing runs, no. Laminar adds SQL over your own span store, a composable dashboard,
labeling queues, a transcript view, and many more integrations. AcruxCore does not replace that.

For what happens before the call, yes. Laminar has no prompt store that your code fetches, and
no request path, so it cannot enforce a spend cap or serve a cached response. The two also
combine: point your client at AcruxCore's gateway and keep Laminar's SDK instrumenting the run.

To choose, start at the top and stop at the first question you answer yes to.

![Laminar or AcruxCore? A decision flow: if you need SQL, dashboards or labeling queues over your traces, pick Laminar; if cost or access needs a control point, pick AcruxCore; the two can also run together](/img/blog/acruxcore-vs-laminar/decision.webp)

| | Laminar | AcruxCore |
|---|---|---|
| Strongest at | Analysing agent runs: SQL, dashboards, labeling, transcript views, signals, a debugger | Managing the prompts and calls that produce the run: versions, aliases, templates, a gateway that can refuse a call over budget |
| Weakest at | Anything before the call: no runtime prompt store, no request path, no spend control | Asking arbitrary questions of your own trace data |

License, pricing, team model, security and community stats for both, with a source link and a
checked-on date for every fact, are on the [compare page](https://acruxcore.com/compare).

> **Key point:** Laminar starts at the trace and builds upward, and AcruxCore starts at the
> prompt and the request. Teams that need both can send calls through AcruxCore's gateway and keep
> Laminar's SDK on the same run.

## FAQ

### Is Laminar open source?

Yes. Laminar is Apache 2.0, and we ran its self-hosted lite stack with `docker compose up -d`.

### Does Laminar have prompt management?

Not as a store your code fetches at runtime. Its playground docs say you can save versions to
revisit later, and an optional server pipeline groups system prompts seen in traces into
versions. Neither one serves a stored prompt to your code.

### Does Laminar support SQL over traces?

Yes. Laminar's SQL editor runs queries over its ClickHouse span store, with saved queries, an
"Ask AI" button and CSV export. Its MCP server also exposes read-only SQL to a coding agent.

### Does Laminar sit in the request path?

No. Laminar receives spans from your process and never receives the model call. So it cannot
enforce a spend cap, rate-limit a key or serve a cached response.

### Can I use Laminar and AcruxCore together?

Yes. You can point your client at AcruxCore's gateway and keep Laminar's SDK instrumenting the
agent run.

Other head-to-heads: [AcruxCore vs Langfuse](/blog/acruxcore-vs-langfuse) and
[AcruxCore vs Braintrust](/blog/acruxcore-vs-braintrust). Laminar is also covered in
[7 Langfuse alternatives](/blog/langfuse-alternatives) and
[10 LLM observability tools tested hands-on](/blog/hands-on-llm-ops-comparison). To try AcruxCore, start with the
[Quickstart](https://docs.acruxcore.com/docs/getting-started/quickstart).
