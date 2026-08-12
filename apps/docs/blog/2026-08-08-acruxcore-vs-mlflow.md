---
title: "MLflow vs AcruxCore: two gateways, one built-in guardrails and PII detection"
description: We rebuilt the same support-triage prompt on self-hosted MLflow and AcruxCore and ran the identical sequence on both — real screenshots, real SDK output, and a measured latency benchmark, not a feature table copied from docs.
slug: acruxcore-vs-mlflow
date: 2026-08-11
authors: [acrux]
tags: [llmops-comparison, llm-gateway, prompt-management]
image: /img/social-card.png
keywords: [mlflow vs AcruxCore, mlflow alternative, llm ops comparison, ai gateway, prompt registry, mlflow tracing, mlflow guardrails]
---

MLflow is the open-source ML/GenAI platform originally built at Databricks, and by far
the largest, oldest project we've compared AcruxCore against — 27,000+ GitHub stars,
444 contributors, shipping since 2018. Its GenAI side is newer: a Prompt Registry, a
tracing store, LLM-as-judge evaluation, and — the real surprise of this comparison — an
**AI Gateway** that sits in the request path, the same design AcruxCore uses. We built
the same prompt — `vip-support-triage`, a support agent that changes tone for VIP
customers and lists their open tickets — on both platforms, then ran the identical
sequence on each: create the prompt, version it, send a live call through a gateway,
inspect the trace, build a dataset, and call it from an SDK script.

<!-- truncate -->

:::note[Same example, both sides]
Every paired screenshot below comes from the exact same prompt and the exact same
customer message. The downstream model differs slightly: AcruxCore's stored prompt
defaults to `openai/gpt-4o-mini`, but MLflow AI Gateway's own OpenRouter model picker
doesn't offer `gpt-4o-mini` as of this comparison (it's a curated list, not a live
mirror of OpenRouter's catalog) — so MLflow's gateway endpoint and the latency
benchmark both use `openai/gpt-4o` instead. Self-hosted MLflow had no login screen and
no credentials to configure, so this comparison was run as an anonymous local user —
exactly what a reader self-hosting it for the first time would see. License, pricing,
team structure, and community stats live on the [compare
page](https://acruxcore.com/compare) instead of here — they were always tables, and a
price change there is one edit instead of three.
:::

### At a glance

| Aspect | MLflow | AcruxCore | Winner |
|---|---|---|---|
| Where the platform sits | In the request path — a real AI Gateway with usage tracking, budgets, and guardrails | In the request path — routing, caching, budgets | Depends |
| Prompt templating | Full Jinja2 — real `{% if %}`/`{% for %}`, but SDK-only creation | Real nunjucks `{% if %}`/`{% for %}`, UI + SDK creation | AcruxCore |
| Sending a live call | Tokens + latency shown per-call; cost only in the aggregate Usage dashboard | Cost, cache, latency all shown inline per call | AcruxCore |
| Tracing depth | Single span per gateway call, but prompt-version linking is a separate explicit call | Single automatic span, prompt-version linked automatically | AcruxCore |
| Tool handling | MCP Registry — catalogs external MCP *servers*, doesn't execute a tool itself | Versioned catalog, real executed calls, analytics | Depends |
| Evaluation & datasets | Built-in LLM-as-judge + custom code judges; dataset list page didn't refresh after creating one | Version × model sweep from real trace feedback | Depends |
| Measured overhead | −44ms (not distinguishable from zero) | −63ms (not distinguishable from zero) | Tie |
| Guardrails | Safety + PII detection + custom, per gateway endpoint | None | MLflow |
| Spend controls | Budget policy per endpoint — reset period, on-exceeded action | Spend cap per team or virtual key, enforced before the provider call, plus RPM/TPM limits | Tie |

License, pricing, team structure, security, and community stats: see
[AcruxCore vs MLflow on the compare page](https://acruxcore.com/compare).

Full breakdown, screenshots, and the verdict below.

## Where the platform sits — in the request path, or beside it

Every other observability-first platform we've compared sits **beside** the request
path: your own client calls the provider, and the tool ingests a trace after the fact.
MLflow doesn't. Its **AI Gateway** is a real proxy: you create a named endpoint, pick a
provider and model, and get back an OpenAI-compatible URL. Every call through it is
usage-tracked and traced server-side, the same shape as AcruxCore's own gateway.

<details>
<summary>Show screenshot: MLflow AI Gateway endpoint overview</summary>

![MLflow's AI Gateway endpoint overview for vip-support-triage: Provider OpenRouter, Model openai/gpt-4o at 100%, and a "View starter code" panel showing the exact curl for POST /gateway/mlflow/v1/chat/completions with the endpoint name as the model parameter](/img/comparison/mlflow/mf-00-gateway-endpoint-overview.png)

</details>

We created the endpoint, then called it with a plain curl — no SDK, no auth header
beyond what the endpoint already stores — and got a real completion back with
`"provider": "openrouter"` in the response. AcruxCore's own request-path gateway is one
sentence here; see the
[walkthrough](/blog/acruxcore-hands-on-walkthrough#3-send-a-stored-prompt-reference-through-the-gateway)
for the picture.

The endpoint also ships an aggregate **Usage dashboard** — requests, p50/p90/p99
latency, token usage, and cost broken down by model — that neither of the other four
platforms we've compared has an equivalent of.

<details>
<summary>Show screenshot: MLflow AI Gateway usage and cost dashboard</summary>

![MLflow's endpoint Usage tab: 160 requests, 1.10s average latency, 0 errors, 3.16K tokens, and a Cost Breakdown donut chart showing $0.011913 total cost, 100% openai/gpt-4o](/img/comparison/mlflow/mf-10-usage-cost-dashboard.png)

</details>

| Feature | MLflow | AcruxCore |
|---|---|---|
| Where it sits | In the request path — a named Gateway endpoint | In the request path — every call routes through it |
| Provider/model picker | Curated list per provider (60+ providers) — some models absent even if the provider serves them | Any model string your registered credential supports |
| Aggregate cost/usage view | Per-endpoint dashboard: requests, latency percentiles, tokens, cost by model | Team-wide Gateway Telemetry |
| Per-call cost shown inline | No — see "Sending a live call" below | Yes |

## Spend controls — both platforms stop the call

Sitting in the request path is what makes a spend cap enforceable rather than
advisory, and both platforms use it. MLflow's **Budgets** page (under AI Gateway)
creates a policy per endpoint: a reset period, an action for when it's exceeded, and a
spending window, tracked against real current spend. No policy existed on this build,
so this is a comparison of the two configuration surfaces, not of two enforcement
runs.

AcruxCore's cap is scoped to a team or to a single virtual key, over a day, week,
month, or the key's whole lifetime. Enforcement happens before the provider is called:
the request reserves its estimated cost against the cap, and one that would cross it
comes back `402 BUDGET_EXCEEDED` instead of being billed. Owners and admins get an
email once at 80% of the cap and again when it's exhausted. Separately, a virtual key
can carry RPM and TPM limits, which return `429` on the same pre-call path.

<details>
<summary>Show screenshot: Budgets on MLflow</summary>

![MLflow's empty Budgets page: "No budget policies created. Set spending limits and control costs across your endpoints," with a Create budget policy button and columns for Reset period, On Exceeded, Window Start/End, and Current Spend](/img/comparison/mlflow/mf-11-budgets.png)

</details>

| Feature | MLflow | AcruxCore |
|---|---|---|
| Cap scope | Per Gateway endpoint | Per team, or per virtual key |
| Reset period | Per-policy spending window | Day, week, month, or total |
| When the cap is hit | Configurable on-exceeded action | `402 BUDGET_EXCEEDED` before the provider call |
| Warning before the cap | Not found | Email to owners and admins at 80% |
| Request rate limiting | Not found | Per-virtual-key RPM and TPM, `429` before the provider call |

## Prompt authoring & versioning

MLflow's Prompt Registry has **no "create" button anywhere in the UI** — the empty
state literally offers "Get help registering a prompt" and "Copy for coding agent."
Every prompt starts life as a `mlflow.genai.register_prompt()` call.

What that call can hold was the real surprise here: MLflow's templates are **full
Jinja2**, not flat `{{variable}}` substitution. We registered the fixture's actual
`{% if is_vip %}...{% else %}...{% endif %}` and `{% for ticket in tickets %}...{%
endfor %}` logic verbatim — no flattening needed, the first competitor in this series
where that's been true.

<details>
<summary>Show screenshots: prompt version and diff view on MLflow</summary>

![MLflow's prompt detail page for vip-support-triage version 3, showing @production and @staging aliases, a commit message, and the full Jinja2 system template with if/else and for-loop syntax rendered as literal text](/img/comparison/mlflow/mf-01-prompt-version-3.png)
![MLflow's word-level diff between version 3 and version 2, with "4" highlighted red and "5" highlighted green on the sentence-count line](/img/comparison/mlflow/mf-02-diff-view.png)
![AcruxCore's Diff tab showing a real unified diff between prompt version 2 and version 3](/img/comparison/acruxcore/acx-03-diff-tab.png)

</details>

MLflow also has real `@production` / `@staging` aliases — `set_prompt_alias()` — the
same functional idea as AcruxCore's aliases, just set via SDK call rather than a UI
button. AcruxCore's own prompt editor is one sentence here; see the
[walkthrough](/blog/acruxcore-hands-on-walkthrough#2-create-a-prompt-version-it-and-promote-an-alias)
for the picture.

| Feature | MLflow | AcruxCore |
|---|---|---|
| Conditional templating | Full Jinja2 — verified hands-on, `{% if %}`/`{% for %}` both work | Real nunjucks `{% if %}`/`{% for %}`, rendered server-side |
| Creating a prompt | SDK only — no UI form anywhere | UI form or SDK |
| Version comparison | Real word-level diff | Standing Diff tab, unified word-level diff |
| Live/staging labels | Real `@production`/`@staging` aliases, set via SDK | `production`/`staging` aliases your app fetches at runtime |

## Sending a live call

We sent the rendered prompt through the Gateway endpoint's OpenAI-compatible
`/gateway/mlflow/v1/chat/completions` route. The trace shows tokens, latency, and the
full request/response — but **no cost figure on the individual trace**, even though the
aggregate Usage dashboard above computes cost just fine. Cost lives at the dashboard
level, not the per-call level.

<details>
<summary>Show screenshots: a live gateway call on both platforms</summary>

![MLflow's trace detail for a single gateway call: Inputs showing the user message, a provider/openrouter/openai/gpt-4o span at 1.37s, Outputs with the assistant's reply, and a usage JSON block with prompt_tokens/completion_tokens/total_tokens but no cost field](/img/comparison/mlflow/mf-03-trace-detail.png)
![AcruxCore Playground's Stored-prompt tab, showing the same completion plus a Gateway Telemetry panel with provider, cost, cache status, and latency](/img/comparison/acruxcore/acx-04-playground-run.png)

</details>

| Feature | MLflow | AcruxCore |
|---|---|---|
| Per-call telemetry | Tokens + latency inline; cost only in the aggregate dashboard | Cost, cache status, and latency all shown inline |
| Requires a real key | Yes (stored on the endpoint at creation time) | Yes |

## Tracing & observability

Every Gateway call is traced automatically — that part is a genuine, automatic side
effect, same as AcruxCore. What's *not* automatic is the link back to the prompt
version: MLflow's trace-to-prompt link needs an explicit
`client.link_prompt_versions_to_trace()` call after the request completes. We wrote a
small script (`mlflow_gateway_run.py`) that renders the prompt locally, calls the
Gateway, then makes that separate linking call — and it shows up correctly under the
trace's **Linked prompts** tab.

<details>
<summary>Show screenshot: a trace linked to its prompt version</summary>

![MLflow's trace detail Linked prompts tab, showing a table with one row: prompt name vip-support-triage, version 3](/img/comparison/mlflow/mf-04-trace-linked-prompt.png)
![AcruxCore's trace detail: one LLM span with model, provider, tokens, cost, and latency, linked back to the exact gateway request and prompt version](/img/comparison/acruxcore/acx-05-trace-detail.png)

</details>

| Feature | MLflow | AcruxCore |
|---|---|---|
| Trace shape | Single span per gateway call | Single span per gateway call |
| How the call is traced | Automatic — a side effect of the Gateway call | Automatic — a side effect of the gateway call |
| Prompt-version lineage | Requires an explicit `link_prompt_versions_to_trace()` call | Automatic — attached at render time |

## How tools are handled — schema registry, or execution

MLflow's answer here is an **MCP Registry** (Beta): you register an external [Model
Context Protocol](https://modelcontextprotocol.io/) server by pasting its `server.json`
manifest — name, source repo, icon, tags. It's a discovery catalog for MCP *servers*
your agents can connect to, not a schema-and-execution catalog for individual tools.

<details>
<summary>Show screenshots: MCP Registry on MLflow, Tool Catalog on AcruxCore</summary>

![MLflow's empty MCP Registry page, with a "Create MCP server" button and the description "Register and catalog MCP servers for your organization"](/img/comparison/mlflow/mf-05-mcp-registry.png)
![AcruxCore's Tool analytics page — call volume, error rate, and P50/P95 latency per tool, aggregated from traced executions](/img/comparison/acruxcore/acx-08-tool-analytics.png)

</details>

Neither model is strictly better — they answer different questions. MLflow's registry
answers "which MCP servers exist and are they reachable?" AcruxCore's catalog answers
"what did this specific tool call cost, and how often does it fail?" Nothing in MLflow's
MCP Registry executes a tool call or records its latency; nothing in AcruxCore's
catalog discovers external MCP servers.

| Feature | MLflow | AcruxCore |
|---|---|---|
| What's catalogued | External MCP servers, via a `server.json` manifest | Individual tool schemas, defined and versioned in-platform |
| Execution | None — it's a discovery registry, not an execution path | Real, gateway-executed calls |
| Analytics | Not applicable | Calls, error rate, and latency per tool |

## Evaluation & datasets

MLflow ships **built-in LLM-as-judge** and custom code judges from an empty state with
two clear entry points, plus dataset creation from the UI or from any trace via "Add to
dataset."

<details>
<summary>Show screenshots: Judges and a populated evaluation dataset on MLflow</summary>

![MLflow's empty Judges page: "Add a judge to your experiment to measure your GenAI app quality," with New LLM judge and New custom code judge buttons](/img/comparison/mlflow/mf-07-judges.png)
![MLflow's vip-support-triage-eval dataset detail page with 2 records, each an Inputs/Expectations pair, tagged with the creating user](/img/comparison/mlflow/mf-06-eval-dataset.png)

</details>

One real bug hit hands-on: after creating the dataset and naming it, the **Datasets
list page kept showing its empty "Create an evaluation dataset" state** — reloading
didn't fix it. The dataset existed the whole time (confirmed via
`mlflow.genai.datasets.search_datasets()`, and its own detail page rendered fine when
linked directly) — the list view just never picked it up in this build.

AcruxCore's dataset — built from a real feedback row — is one sentence here; see the
[walkthrough](/blog/acruxcore-hands-on-walkthrough#5-build-a-dataset-from-real-feedback)
for the screenshot.

| Feature | MLflow | AcruxCore |
|---|---|---|
| LLM-as-judge | Built-in judges, plus custom code judges | Not built in |
| Dataset creation | UI form, or "Add to dataset" from any trace | From trace feedback, span-level only |
| Datasets list page | Confirmed bug: didn't show a dataset that existed server-side | Not applicable |

## SDK & developer experience

MLflow's SDK has dedicated surfaces for each step — `load_prompt()`,
`start_span()`, and a separate `link_prompt_versions_to_trace()` call. AcruxCore's two
calls (`hub.prompts.render()`, `hub.gateway.chat()`) do the same three things — render,
call, trace-and-link — in one round trip.

```python title="mlflow_gateway_run.py"
prompt = mlflow.genai.load_prompt("prompts:/vip-support-triage@production")
rendered = prompt.format(**VARIABLES)

with mlflow.start_span(name="vip-support-triage-gateway-call") as span:
    resp = requests.post(f"{TRACKING_URI}/gateway/mlflow/v1/chat/completions",
                          json={"model": "vip-support-triage", "messages": rendered})
    trace_id = span.trace_id

mlflow.MlflowClient().link_prompt_versions_to_trace(
    trace_id=trace_id, prompt_versions=[prompt]
)
```

```python title="acx_sdk_run.py"
rendered = await hub.prompts.render("vip-support-triage", "production", VARIABLES)
result = await hub.gateway.chat(
    rendered.model, rendered.messages,
    temperature=0, max_tokens=256,
    prompt_version_id=rendered.version_id,
)
```

Real output, both platforms:

```json title="mlflow_gateway_run.py output"
{
  "content": "I apologize for the inconvenience. I'll prioritize your request and have our support team review your open ticket #4821 regarding the billing export button...",
  "model": "openai/gpt-4o",
  "prompt_tokens": 95,
  "completion_tokens": 45,
  "elapsed_s": 2.232,
  "trace_id": "tr-50862fac52f978588cca2bc167fc3aa2"
}
```

```json title="acx_sdk_run.py output"
{
  "content": "I apologize for the inconvenience with the billing export button. I will escalate this issue immediately...",
  "model": "openai/gpt-4o-mini",
  "prompt_tokens": 100,
  "completion_tokens": 51,
  "cost_usd": 0.0000456,
  "trace_id": "a5a2324c-4c48-4e40-8bfb-2b8379772d67"
}
```

Full scripts:
[`mlflow_gateway_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/mlflow-vs-acruxcore/python/mlflow_gateway_run.py)
and
[`acx_sdk_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/mlflow-vs-acruxcore/python/acx_sdk_run.py).

| Feature | MLflow | AcruxCore |
|---|---|---|
| SDK model | Separate render / call / link-to-trace calls | Two calls: render, then gateway-chat (traces automatically) |
| Cost in the return value | No — not on the trace or the passthrough response | Yes — `cost_usd` on every gateway response |

## Latency overhead — measured

We timed the identical call three ways, interleaved in rotating order over 100 rounds
so a network blip hits all three equally: a raw direct call to OpenRouter (baseline),
the same call through MLflow's AI Gateway endpoint, and the same call through
AcruxCore's gateway. All three used `openai/gpt-4o` via OpenRouter — see the note at the
top for why not `gpt-4o-mini`.

| Path | median | p95 | p99 |
|---|---|---|---|
| Direct to provider | 1005 ms | 1267 ms | 1413 ms |
| MLflow AI Gateway | 961 ms | 2162 ms | 2533 ms |
| AcruxCore gateway | 943 ms | 2316 ms | 2735 ms |

With a 95% bootstrap confidence interval on the gap against the direct-call baseline:
MLflow's gap is **−44ms** (CI [−98, +85]ms) and AcruxCore's is **−63ms** (CI [−120,
+70]ms) — both cross zero, meaning neither gateway's overhead is statistically
distinguishable from the direct call at this sample size. The p95/p99 tails are wider
for both gateways than the direct baseline, which is the extra-hop cost showing up in
the slower rounds even where the median doesn't move.

Full script:
[`latency_bench.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/mlflow-vs-acruxcore/python/latency_bench.py).

## Friction hit during this run

Real friction hit while doing this comparison, not a symmetric wish list.

**MLflow**
- 👍 No login wall at all on self-host — straight into a working instance.
- 👍 Full Jinja2 templates — no flattening needed, the first competitor in this series
  where that's true.
- 👍 A real Gateway endpoint with a working curl snippet shown right on its overview page.
- 👎 The OpenRouter model picker doesn't include `gpt-4o-mini`, even though OpenRouter's
  own live catalog still serves it — the picker is a curated static list, not a mirror
  of the provider's actual catalog.
- 👎 The Datasets list page didn't show a dataset that demonstrably existed server-side.
- 👎 Linking a trace to its prompt version needs a separate, easy-to-forget SDK call.

**AcruxCore**
- 👍 One gateway call, and the trace *and* its prompt-version link both happen for free.
- 👍 Cost is on every gateway response, not just an aggregate dashboard.
- 👎 A model with no registered per-1M rate shows a blank `—` cost instead of `$0` or an
  estimate, until you register one.

## What MLflow does that AcruxCore doesn't

Sourced from MLflow's own dashboard and docs, not from this post's earlier aspects —
those carry the same bias any of our own feature list would.

**Guardrails — Safety and PII detection, built into every Gateway endpoint.**
Each endpoint has its own Guardrails tab, and creating one offers three types: a Safety
guardrail ("detects harmful, offensive, or toxic content"), a PII Detection guardrail
("detects personally identifiable information such as names, emails, and phone
numbers"), or a fully custom guardrail with your own instructions. AcruxCore has no
equivalent: nothing inspects a call's input or output for unsafe content or personal
data before or after it reaches the model.

<details>
<summary>Show screenshot: guardrail types on MLflow</summary>

![MLflow's "Create Guardrail" dialog, showing three options: Safety (detects harmful, offensive, or toxic content), PII Detection (detects names, emails, and phone numbers), and Custom Guardrail](/img/comparison/mlflow/mf-09-guardrail-types.png)

</details>

**An MCP Registry, and a built-in AI assistant.** Beyond guardrails: MLflow's MCP
Registry (covered in "How tools are handled") has no AcruxCore equivalent at all, and
every page ships a docked "MLflow Assistant" chat panel that can answer questions about
your own experiments, traces, and evaluations, plus a one-click "Detect Issues" button
on the experiment overview that uses AI to flag latency and correctness problems across
recent traces. AcruxCore has no in-product assistant or automated issue detection.

AcruxCore has no equivalent to any of the three — no guardrails, no MCP server catalog,
and no in-product AI assistant.

## Verdict

| | MLflow | AcruxCore |
|---|---|---|
| Strongest at | Guardrails and PII detection, full Jinja2 prompt logic, a genuinely request-path gateway, LLM-as-judge evaluation | Cost shown on every call, automatic prompt-version lineage, a tool catalog that actually executes and measures calls |
| Weakest at | No cost on individual traces, prompt-version linking needs a separate call, a real dataset-list UI bug hit hands-on | No guardrails, no MCP server registry |
| Pick it if | You want guardrails and full templating logic layered onto a platform that's also a serious classical-ML tracker | You want the provider call itself — gateway, cost, tools, prompt lineage — traced for free, with nothing bolted on after the fact |

This is the closest structural match to AcruxCore of any competitor we've compared:
both run a real gateway in the request path, and both trace as a side effect of that
same call. Both enforce a spend cap on that path (**Spend controls** above). Where they
diverge is what sits *around* the call — MLflow layers on guardrails that AcruxCore
doesn't have (**What MLflow does that AcruxCore doesn't** above); AcruxCore keeps cost
and prompt lineage automatic and
inline where MLflow makes you dashboard-hunt for cost or make a second SDK call for
lineage (**Sending a live call** and **Tracing & observability** above). See the full
picture, including license, pricing, and team structure, on the [compare
page](https://acruxcore.com/compare).

Want to run this yourself? The
[Quickstart](/docs/getting-started/quickstart) gets you from sign-up to a traced,
gateway-routed call in about ten minutes.
