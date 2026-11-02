---
title: "AcruxCore vs MLflow: two gateways, one with guardrails"
description: "AcruxCore vs MLflow: two AI gateways in the request path, compared on guardrails, Jinja2 prompts, per-call cost, prompt lineage and spend controls."
slug: acruxcore-vs-mlflow
date: 2026-08-11
authors: [acrux]
tags: [llmops-comparison, llm-gateway, prompt-management]
image: /img/blog/acruxcore-vs-mlflow/header.webp
keywords: [AcruxCore vs mlflow, mlflow vs AcruxCore, llm ops comparison, ai gateway, prompt registry, mlflow tracing, mlflow guardrails]
last_update:
  date: 2026-11-02
---

![Two gateways in the request path: MLflow is strongest at guardrails and PII detection, full Jinja2 prompt logic, LLM-as-judge evaluation and classical-ML tracking; AcruxCore at cost per call, prompt-version lineage, a tool catalog and spend caps](/img/blog/acruxcore-vs-mlflow/header.webp)

MLflow is the open-source ML and GenAI platform first built at Databricks. It has shipped since
2018 and had about 28,500 GitHub stars and 447 contributors on 25 October 2026. Its GenAI side
is newer: a Prompt Registry, a tracing store, LLM-as-judge evaluation, and an **AI Gateway**
that sits in the request path. AcruxCore's gateway sits there too, so this comparison is
between two request-path gateways. We sent the same support prompt,
`vip-support-triage`, through both. The prompt changes tone for VIP customers and lists their
open tickets. We registered and versioned it, called it through each gateway, linked the trace
to its prompt version, and built an evaluation dataset.

The short answer: MLflow has Safety, PII and custom guardrails on every gateway endpoint, full
Jinja2 prompts, and an experiment tracker for classical ML, and AcruxCore has no guardrails.
AcruxCore returns cost on every gateway response and runs the tools in its catalog. Linking a
trace to its prompt version takes a separate SDK call on MLflow and one argument on AcruxCore.

AcruxCore is our product. The MLflow and AcruxCore scripts are linked in each section.

<!-- truncate -->

## How we tested

- **MLflow:** version 3.15.1, self-hosted. `mlflow server` ran in a Docker container on the same
  machine as the test scripts, at `http://localhost:5000`. The AI Gateway is served by that same
  tracking-server process, not a separate one. The instance had no login screen, so we worked as
  the anonymous local user that a first-time self-hoster sees. The server's worker count was not
  recorded.
- **Model in the screenshots:** the same prompt and the same customer message on both
  platforms. AcruxCore's stored prompt uses `openai/gpt-4o-mini`. MLflow AI Gateway's OpenRouter
  model picker is a curated list that did not offer `gpt-4o-mini`, so the MLflow screenshots and
  the MLflow SDK output below use `openai/gpt-4o`.
- **Model in the latency benchmark:** both gateways used a native OpenAI provider on
  `gpt-4o-mini`, so every leg ends at `api.openai.com`.
- **Dates:** the hands-on steps and screenshots are from 8 August 2026, on MLflow 3.15.1. The
  latency figures come from three benchmark runs committed on 7 September 2026. The MLflow
  version for those runs was not recorded separately.
- **AcruxCore:** the benchmark called a local AcruxCore gateway at `http://localhost:3001`.
  Hardware not recorded.

### At a glance

| Aspect | MLflow | AcruxCore |
|---|---|---|
| Where the platform sits | In the request path: an AI Gateway with usage tracking, budget policies and guardrails | In the request path: routing, caching, budgets |
| Prompt templating | Full Jinja2, `{% if %}`/`{% for %}`, created in a UI form or the SDK | Nunjucks `{% if %}`/`{% for %}`, UI + SDK creation |
| Sending a live call | Cost per span from 3.10 with the `[genai]` extra, per docs; none on our install, which showed tokens + latency | Cost, cache, latency all shown inline per call |
| Prompt-version lineage | A separate `link_prompt_versions_to_trace()` call after the request | One `prompt_version_id` argument on the gateway call, or none with a `prompt` reference |
| Tool handling | MCP Registry: catalogs external MCP *servers*, doesn't execute a tool itself | Versioned catalog, executed calls, analytics |
| Evaluation & datasets | Built-in LLM-as-judge + custom code judges; dataset list page didn't refresh after creating one | Version × model sweep from trace feedback |
| Guardrails | Safety, PII detection and custom, per gateway endpoint, before or after the model call | None |
| Spend controls | Budget policies: Alert fires a webhook, Reject returns HTTP 429 on later requests (per docs, not tested) | Spend cap per team or virtual key, checked before the provider call, plus RPM/TPM limits |
| MCP server | [Experimental](https://mlflow.org/docs/latest/genai/mcp/): the default `genai` group has tools for traces, scorers, experiments and runs; an optional `ml` group has experiments, runs, models and deployments; no Prompt Registry tools | [Hosted or local](https://docs.acruxcore.com/docs/guides/connect-an-mcp-client): commit, promote and run stored prompts, read traces, run experiments |

- **Pick MLflow if** you want Safety and PII guardrails and full Jinja2 templates on a platform
  that is also your classical-ML experiment tracker.
- **Pick AcruxCore if** you want cost in every gateway response, prompt-version lineage without a second SDK
  call, and a tool catalog that runs and measures tool calls.

License, pricing, team structure, security, and community stats: see
[AcruxCore vs MLflow on the compare page](https://acruxcore.com/compare).

## Two gateways in the request path

MLflow's **AI Gateway** is a proxy. You create a named endpoint, pick a provider and model, and
get back an OpenAI-compatible URL. Every call through it is usage-tracked and traced on the
server, the same shape as AcruxCore's gateway.

<details>
<summary>Show screenshot: MLflow AI Gateway endpoint overview</summary>

![MLflow's AI Gateway endpoint overview for vip-support-triage: Provider OpenRouter, Model openai/gpt-4o at 100%, and a "View starter code" panel showing the exact curl for POST /gateway/mlflow/v1/chat/completions with the endpoint name as the model parameter](/img/comparison/mlflow/mf-00-gateway-endpoint-overview.png)

</details>

We created the endpoint and called it with a plain curl, with no SDK and no auth header beyond
what the endpoint already stores. The completion came back with `"provider": "openrouter"` in
the response.

The endpoint also has an aggregate **Usage dashboard**: requests, p50/p90/p99 latency, token
usage, and cost broken down by model.

<details>
<summary>Show screenshot: MLflow AI Gateway usage and cost dashboard</summary>

![MLflow's endpoint Usage tab: 160 requests, 1.10s average latency, 0 errors, 3.16K tokens, and a Cost Breakdown donut chart showing $0.011913 total cost, 100% openai/gpt-4o](/img/comparison/mlflow/mf-10-usage-cost-dashboard.png)

</details>

| Feature | MLflow | AcruxCore |
|---|---|---|
| Where it sits | In the request path: a named Gateway endpoint | In the request path: every call routes through it |
| Provider/model picker | Curated list per provider; `gpt-4o-mini` was missing from the OpenRouter list even though OpenRouter serves it | Any model string your registered credential supports |
| Aggregate cost/usage view | Per-endpoint dashboard: requests, latency percentiles, tokens, cost by model | Team-wide Gateway Telemetry |
| Per-call cost shown inline | Partial: per span from 3.10 with the `[genai]` extra, per docs; none on our install | Yes |

## Spend controls: what each platform configures

MLflow's **Budgets** page, under AI Gateway, creates budget policies. No policy existed on this
build, and we did not create one, so this section compares what each product documents and
configures, not two enforcement runs. MLflow's docs describe two actions (checked on
2 November 2026):

- **Alert** "fires a webhook notification. Requests continue normally."
- **Reject** "blocks subsequent requests with HTTP 429." The docs add that "the request that
  causes the spend to exceed the budget is allowed to complete."
- A budget resets daily, weekly or monthly, and "can be scoped to a specific workspace" when
  workspaces are enabled.

AcruxCore's cap is scoped to a team or to a single virtual key, over a day, week, month, or the
key's whole lifetime. Before the provider is called, the request reserves its estimated cost
against the cap, and a request that would cross it comes back `402 BUDGET_EXCEEDED` instead of
being billed. Owners and admins get an email at 80% of the cap and again when it's used up.
Separately, a virtual key can carry RPM and TPM limits, which return `429` on the same pre-call
path.

<details>
<summary>Show screenshot: Budgets on MLflow</summary>

![MLflow's empty Budgets page: "No budget policies created. Set spending limits and control costs across your endpoints," with a Create budget policy button and columns for Reset period, On Exceeded, Window Start/End, and Current Spend](/img/comparison/mlflow/mf-11-budgets.png)

</details>

| Feature | MLflow | AcruxCore |
|---|---|---|
| Cap scope | Global, or one workspace | Per team, or per virtual key |
| Reset period | Daily, weekly or monthly | Day, week, month, or total |
| When the cap is hit | Alert: webhook, requests continue. Reject: later requests get HTTP 429 | `402 BUDGET_EXCEEDED` before the provider call |
| Warning before the cap | Not described; an Alert fires once the threshold is exceeded | Email to owners and admins at 80% |
| Request rate limiting | Not described in MLflow's gateway docs | Per-virtual-key RPM and TPM, `429` before the provider call |

## Prompt authoring & versioning

MLflow's empty Prompts page opens with "Create your first prompt". Below it, a card offers "Get
help registering a prompt", and an "Or create a prompt manually" button opens a form. We
registered ours with `mlflow.genai.register_prompt()`.

That call accepts **full Jinja2**, not only flat `{{variable}}` substitution. We registered the
prompt's `{% if is_vip %}...{% else %}...{% endif %}` and
`{% for ticket in tickets %}...{% endfor %}` logic as written, with no flattening.

<details>
<summary>Show screenshots: prompt version and diff view on MLflow</summary>

![MLflow's prompt detail page for vip-support-triage version 3, showing @production and @staging aliases, a commit message, and the full Jinja2 system template with if/else and for-loop syntax rendered as literal text](/img/comparison/mlflow/mf-01-prompt-version-3.png)
![MLflow's word-level diff between version 3 and version 2, with "4" highlighted red and "5" highlighted green on the sentence-count line](/img/comparison/mlflow/mf-02-diff-view.png)

</details>

MLflow also has `@production` / `@staging` aliases. They do the same job as AcruxCore's
aliases. You set them with `set_prompt_alias()` or from the version's "Add/edit alias" dialog.

| Feature | MLflow | AcruxCore |
|---|---|---|
| Conditional templating | Full Jinja2, verified hands-on: `{% if %}`/`{% for %}` both work | Nunjucks `{% if %}`/`{% for %}`, rendered server-side |
| Creating a prompt | UI form or SDK | UI form or SDK |
| Version comparison | Word-level diff | Diff tab, unified word-level diff |
| Live/staging labels | `@production`/`@staging` aliases, set in the UI or SDK | `production`/`staging` aliases, promoted from the Versions tab |

## Sending a live call

We sent the rendered prompt through the Gateway endpoint's OpenAI-compatible
`/gateway/mlflow/v1/chat/completions` route. The trace shows tokens, latency, and the full
request and response. Our self-hosted run showed tokens and latency but no cost. MLflow's
[docs](https://mlflow.org/docs/latest/genai/tracing/token-usage-cost/) say cost is recorded per
span from 3.10 when the server has the `[genai]` extra, and shows $0.00 when the model has no
price entry. We did not re-test with that extra. The aggregate Usage dashboard above does
compute cost.

<details>
<summary>Show screenshots: a live gateway call on both platforms</summary>

![MLflow's trace detail for a single gateway call: Inputs showing the user message, a provider/openrouter/openai/gpt-4o span at 1.37s, Outputs with the assistant's reply, and a usage JSON block with prompt_tokens/completion_tokens/total_tokens but no cost field](/img/comparison/mlflow/mf-03-trace-detail.png)
![AcruxCore's Playground running the stored vip-support-triage prompt on its production alias, with a Gateway Telemetry bar under the request showing provider, model, $0.0000414 cost, cache miss, 1.83 s latency and tokens](/img/comparison/acruxcore/acx-04-playground-run.png)

</details>

| Feature | MLflow | AcruxCore |
|---|---|---|
| Per-call telemetry | Partial: tokens + latency inline; cost per span from 3.10 with the `[genai]` extra, per docs; none on our install | Cost, cache status, and latency all shown inline |
| Requires a provider key | Yes (stored on the endpoint at creation time) | Yes |

## Tracing & observability

Both gateways trace every call automatically. The difference is the link back to the prompt
version. On MLflow it needs an explicit `client.link_prompt_versions_to_trace()` call after the
request completes. Our script (`mlflow_gateway_run.py`) renders the prompt locally, calls the
Gateway, then makes that linking call, and the link shows up under the trace's **Linked
prompts** tab.

On AcruxCore, the link comes from the gateway call. Our script renders first and passes
`prompt_version_id=rendered.version_id`, one argument on the same call. A gateway call that
names the stored prompt with a `prompt` reference renders it on the server and records the
version with no argument at all.

<details>
<summary>Show screenshots: a trace linked to its prompt version on both platforms</summary>

![MLflow's trace detail Linked prompts tab, showing a table with one row: prompt name vip-support-triage, version 3](/img/comparison/mlflow/mf-04-trace-linked-prompt.png)
![AcruxCore's trace detail for the same support message, with a "View traces for this prompt version" link under the span's model, tokens, cost and latency](/img/comparison/acruxcore/acx-05-trace-detail.png)

</details>

| Feature | MLflow | AcruxCore |
|---|---|---|
| Trace shape | Single span per gateway call | Single span per gateway call |
| How the call is traced | Automatic, as part of the Gateway call | Automatic, as part of the gateway call |
| Prompt-version lineage | A separate `link_prompt_versions_to_trace()` call | `prompt_version_id` on the gateway call, or automatic with a `prompt` reference |

## Tools: a registry of MCP servers, or a catalog that runs tools

MLflow's answer here is an **MCP Registry** (Beta). You register an external
[Model Context Protocol](https://modelcontextprotocol.io/) server by pasting its `server.json`
manifest: name, source repo, icon, tags. It is a discovery catalog for MCP *servers* your agents
can connect to, not a catalog of individual tools that it runs.

<details>
<summary>Show screenshot: MCP Registry on MLflow</summary>

![MLflow's empty MCP Registry page, with a "Create MCP server" button and the description "Register and catalog MCP servers for your organization"](/img/comparison/mlflow/mf-05-mcp-registry.png)

</details>

The two answer different questions. MLflow's registry answers "which MCP servers exist and are
they reachable?" AcruxCore's catalog answers "what did this tool call cost, and how often does
it fail?" Nothing in MLflow's MCP Registry executes a tool call or records its latency, and
nothing in AcruxCore's catalog discovers external MCP servers.

| Feature | MLflow | AcruxCore |
|---|---|---|
| What's catalogued | External MCP servers, via a `server.json` manifest | Individual tool schemas, defined and versioned in-platform |
| Execution | None: a discovery registry, not an execution path | Gateway-executed calls |
| Analytics | Not applicable | Calls, error rate, and latency per tool |

## Evaluation & datasets

MLflow has **built-in LLM-as-judge** and custom code judges, with two entry points on an empty
state. Datasets can be created from the UI or from any trace with "Add to dataset".

<details>
<summary>Show screenshots: Judges and a populated evaluation dataset on MLflow</summary>

![MLflow's empty Judges page: "Add a judge to your experiment to measure your GenAI app quality," with New LLM judge and New custom code judge buttons](/img/comparison/mlflow/mf-07-judges.png)
![MLflow's vip-support-triage-eval dataset detail page with 2 records, each an Inputs/Expectations pair, tagged with the creating user](/img/comparison/mlflow/mf-06-eval-dataset.png)

</details>

One bug hit hands-on: after we created and named the dataset, the **Datasets list page kept
showing its empty "Create an evaluation dataset" state**, and reloading didn't fix it. The
dataset existed the whole time. `mlflow.genai.datasets.search_datasets()` returned it, and its
own detail page rendered when linked directly. The list view never picked it up in this build.

| Feature | MLflow | AcruxCore |
|---|---|---|
| LLM-as-judge | Built-in judges, plus custom code judges | Built-in judge on experiment runs and live traffic, or your own judge prompt; code scorers in the SDK |
| Dataset creation | UI form, or "Add to dataset" from any trace | Span-level trace feedback, manual entry, API, or a CSV/JSON file |
| Datasets list page | Bug on 3.15.1: didn't show a dataset that existed server-side | Not applicable |

## SDK & developer experience

MLflow's SDK has a call for each step: `load_prompt()`, `start_span()`, and a separate
`link_prompt_versions_to_trace()`. AcruxCore's script makes two calls, `hub.prompts.render()`
and `hub.gateway.chat()`, and the second one also records the trace and its prompt version.

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

Output from each script. The two ran on different models (see **How we tested**), so compare
the fields, not the replies.

<details>
<summary>Show output: mlflow_gateway_run.py and acx_sdk_run.py</summary>

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

</details>

:::github
- [`mlflow_gateway_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/mlflow-vs-acruxcore/python/mlflow_gateway_run.py) — the MLflow run.
- [`acx_sdk_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/mlflow-vs-acruxcore/python/acx_sdk_run.py) — the AcruxCore run.
:::

| Feature | MLflow | AcruxCore |
|---|---|---|
| SDK model | Separate render / call / link-to-trace calls | Render, then gateway-chat with the version id (traces automatically) |
| Cost in the return value | No: not in the gateway's response body | Yes: `cost_usd` on every gateway response |

## Latency overhead — measured

Because both gateways sit in the request path, their hop can be timed the same way. The
benchmark sent one fixed call ("Reply with the single word: pong." on `gpt-4o-mini`) directly
to `api.openai.com`, through MLflow's AI Gateway endpoint, and through AcruxCore's gateway. Both
gateways ran locally (see **How we tested**) and forwarded to a native OpenAI provider. Each run
has 100 interleaved rounds, and we ran it three times.

| Run | Direct-call median | MLflow gap | AcruxCore gap |
|---|---|---|---|
| 1 | 611 ms | +225 ms, CI [+112, +275] | +21 ms, CI [+5, +35] |
| 2 | 611 ms | +157 ms, CI [+73, +250] | +43 ms, CI [+22, +58] |
| 3 | 613 ms | +135 ms, CI [+63, +255] | +36 ms, CI [+23, +55] |

- MLflow's gap was +135 to +225 ms, and no interval crossed zero.
- AcruxCore's gap was +21 to +43 ms, and no interval crossed zero.
- We did not record how many workers the MLflow server ran, so these figures describe MLflow as
  we ran it, not a tuned deployment.

Our other benchmarks do not agree with this run, so treat the MLflow figure as unsettled. Our
August [full-cycle benchmark](/blog/full-cycle-latency-benchmark) loaded the stored prompt and
sent it as one merged message. In the latest of its four runs, MLflow's gateway measured −81 ms
against a direct call, with an interval of −155 to +34 ms. For AcruxCore, our newest measurement
of a local gateway on its own, on 25 October 2026, found +9 ms with an interval of −15 to +28 ms
([method](/blog/llm-gateway-overhead)).

:::github
[`latency_bench.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/mlflow-vs-acruxcore/python/latency_bench.py) — the latency benchmark.
:::

## Friction hit during this run

**MLflow**
- 👍 No login wall on self-host: straight into a working instance.
- 👍 Full Jinja2 templates, with no flattening.
- 👍 A Gateway endpoint with a working curl snippet on its overview page.
- 👎 The OpenRouter model picker doesn't include `gpt-4o-mini`, even though OpenRouter's own
  live catalog serves it. The picker is a curated static list, not a mirror of the provider's
  catalog.
- 👎 The Datasets list page didn't show a dataset that existed server-side.
- 👎 Linking a trace to its prompt version needs a separate SDK call that is easy to forget.

**AcruxCore**
- 👍 The trace and its prompt-version link come from the gateway call itself.
- 👍 Cost is on every gateway response, not only in an aggregate dashboard.
- 👎 No content guardrails to turn on for an endpoint.

## What MLflow does that AcruxCore doesn't

**Guardrails: Safety and PII detection, built into every Gateway endpoint.** Each endpoint has
its own Guardrails tab, and creating one offers three types. A Safety guardrail "detects
harmful, offensive, or toxic content". A PII Detection guardrail "detects personally
identifiable information such as names, emails, and phone numbers". A custom guardrail takes
your own instructions. MLflow's docs say a guardrail runs either before the request reaches the
model or after the response, and that post-LLM guardrails are not applied to streaming requests
(checked on 2 November 2026). AcruxCore has no equivalent: nothing checks a call's input or
output for unsafe content or personal data.

<details>
<summary>Show screenshot: guardrail types on MLflow</summary>

![MLflow's "Create Guardrail" dialog, showing three options: Safety (detects harmful, offensive, or toxic content), PII Detection (detects names, emails, and phone numbers), and Custom Guardrail](/img/comparison/mlflow/mf-09-guardrail-types.png)

</details>

**An MCP Registry, and a built-in AI assistant.** MLflow's MCP Registry (covered in **Tools**
above) has no AcruxCore equivalent. Every page also has a docked "MLflow Assistant" chat panel
that answers questions about your own experiments, traces and evaluations. The experiment
overview has a one-click "Detect Issues" button that uses AI to flag latency and correctness
problems across recent traces.

AcruxCore has none of these four: no guardrails, no catalog of external MCP servers, no
in-product AI assistant, and no automated issue detection.

## Is AcruxCore an MLflow alternative?

Partly. MLflow is also an experiment tracker for classical ML. If you already run MLflow for
that, nothing here suggests removing it.

As an LLM gateway, MLflow has the same design as ours, and the differences sit around the call.
MLflow has Safety, PII and custom guardrails on every endpoint, and budget policies that alert
or reject later requests. AcruxCore has spend caps checked before the call and per-key rate
limits, but no content guardrail. AcruxCore returns cost in each gateway response and links the
trace to its prompt version on the same call, where MLflow's response body carries only tokens
and lineage needs a second call.

To choose, start at the top and stop at the first question you answer yes to.

![MLflow or AcruxCore? A decision flow: using MLflow as an experiment tracker for classical ML leads to MLflow; if not, needing content guardrails leads to MLflow; if not, wanting cost per call leads to AcruxCore](/img/blog/acruxcore-vs-mlflow/decision.webp)

| | MLflow | AcruxCore |
|---|---|---|
| Strongest at | Guardrails and PII detection, full Jinja2 prompt logic, a request-path gateway, LLM-as-judge evaluation, classical-ML tracking | Cost shown on every call, prompt-version lineage on the gateway call, a tool catalog that executes and measures calls |
| Weakest at | Prompt-version linking needs a separate call, a dataset-list UI bug hit hands-on | No guardrails, no registry of external MCP servers |

> **Key point:** Pick by what you need around the call. MLflow adds content guardrails to its
> gateway and keeps prompts next to your ML experiments. AcruxCore adds cost per call, lineage on
> the same call, and tools that its gateway runs.

## FAQ

### Does MLflow have an AI gateway?

Yes. MLflow's AI Gateway gives each named endpoint an OpenAI-compatible URL, and every call
through it is usage-tracked and traced. In our self-hosted run it was served by the tracking
server process.

### Does MLflow have guardrails?

Yes. Each gateway endpoint can have a Safety guardrail, a PII Detection guardrail or a custom
guardrail. A guardrail runs before the request reaches the model or after the response, and
post-LLM guardrails are not applied to streaming requests.

### Can MLflow cap spending on its gateway?

MLflow's docs describe budget policies with two actions. Alert fires a webhook and requests
continue. Reject blocks later requests with HTTP 429. We did not test either.

### Does the MLflow Prompt Registry support Jinja2?

Yes. We registered a prompt with `{% if %}` and `{% for %}` blocks as written. We created ours
with `mlflow.genai.register_prompt()`.

### Does MLflow link traces to prompt versions?

Yes, with a separate `link_prompt_versions_to_trace()` call after the request. The link then
appears on the trace's Linked prompts tab.

Other head-to-heads: [AcruxCore vs Opik](/blog/acruxcore-vs-opik) and
[AcruxCore vs Arize Phoenix](/blog/acruxcore-vs-phoenix). Gateways you run with your own keys
are ranked in [13 OpenRouter alternatives](/blog/openrouter-alternatives). MLflow is also covered
in [9 Braintrust alternatives](/blog/braintrust-alternatives) and
[10 LLM observability tools tested hands-on](/blog/hands-on-llm-ops-comparison).
