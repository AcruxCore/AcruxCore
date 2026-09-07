---
title: "Langfuse alternative: org hierarchy vs a flat team"
description: A Langfuse alternative tested hands-on — the same prompt rebuilt and run on both, with real screenshots, an SDK trace and a measured latency benchmark.
slug: acruxcore-vs-langfuse
authors: [acrux]
tags: [llmops-comparison, prompt-management, llm-tracing]
image: /img/social-card.png
keywords: [langfuse alternative, langfuse alternatives, open source langfuse alternative, langfuse vs AcruxCore, llm ops comparison, prompt versioning, ai gateway, llm tracing]
---

Langfuse is the LLM-ops platform we get compared to most often, and it deserves a real
answer, not a table copied from two docs sites. So we built the same prompt —
`vip-support-triage`, a support agent that changes tone for VIP customers and lists
their open tickets — on both platforms, then ran the identical sequence on each: create
the prompt, version it, send a live call, inspect the trace, build a dataset, run an
experiment, and call it from an SDK script.

<!-- truncate -->

:::note[Same example, both sides]
Every paired screenshot below comes from the exact same prompt and the exact same
customer message, sent through the exact same downstream model
(`openai/gpt-4o-mini` via OpenRouter) on both platforms. The latency benchmark further
down is separate: every leg of it goes straight to `api.openai.com`, so the two sections
quote different upstreams on purpose. Where a step is genuinely
one-sided — no equivalent screen exists on the other product — we say so instead of
padding it out. License, pricing, team structure, and community stats live on the
[compare page](https://acruxcore.com/compare) instead of here — they were always tables, and a
price change there is one edit instead of three.
:::

### At a glance

| Aspect | Langfuse | AcruxCore | Winner |
|---|---|---|---|
| Prompt templating | Flat `{{variable}}` substitution only | Real nunjucks `{% if %}` / `{% for %}` logic | AcruxCore |
| Playground | No cost/latency shown inline | Cost, cache, latency shown inline | AcruxCore |
| Tracing depth | Span tree via client-side OTel instrumentation | Single automatic span | Langfuse |
| Request-path gateway | None — ingests a trace after your own call | Built in — routing, caching, budgets | AcruxCore |
| Tool catalog | A schema saved from the Playground, never executed | Versioned catalog, real executed calls, analytics | AcruxCore |
| Dataset creation | Manual entry, API, or from a trace | From real span-level trace feedback | AcruxCore |
| SDK trace capture | Wrap a client + open an observation context | Automatic side effect of the gateway call | AcruxCore |
| Measured overhead | −22 ms, CI crosses zero | +63 ms, CI crosses zero | Tie |
| Time-to-first-trace | Only via the SDK path, after setup | Zero code, first call | AcruxCore |

License, pricing, team structure, security, and community stats: see
[AcruxCore vs Langfuse on the compare page](https://acruxcore.com/compare).

Full breakdown, screenshots, and the verdict below.

## Prompt authoring & versioning

AcruxCore's editor uses **nunjucks** — real `{% if %}` and `{% for %}` logic, so the
VIP branch and the ticket list live in the template itself. Langfuse's templating is
flat `{{variable}}` substitution only, so we had to pre-render the VIP note and the
ticket list into plain strings before the prompt ever saw them — Langfuse's own commit
message on the recreated prompt says so explicitly.

<details>
<summary>Show screenshots: prompt editor, versions, and the diff tab</summary>

![Langfuse's create-prompt screen for the recreated vip-support-triage prompt, with a commit message noting it was adapted from AcruxCore's nunjucks template since Langfuse only supports flat variable substitution](/img/comparison/langfuse/lf-01-prompt-editor.png)
![Langfuse's prompt versions list showing a single version — no diff or compare control anywhere in the version history UI](/img/comparison/langfuse/lf-02-versions.png)
![AcruxCore's Diff tab showing a real unified diff between prompt version 2 and version 3](/img/comparison/acruxcore/acx-03-diff-tab.png)

</details>

AcruxCore's own prompt editor — real nunjucks conditionals and loops rendering VIP
status and the ticket list inline — is one sentence here; see the
[walkthrough](/blog/acruxcore-hands-on-walkthrough#2-create-a-prompt-version-it-and-promote-an-alias)
for the picture.

| Feature | Langfuse | AcruxCore |
|---|---|---|
| Conditional templating | Flat `{{variable}}` only — verified hands-on, no `{% if %}`/`{% for %}` | Real nunjucks `{% if %}`/`{% for %}`, rendered server-side |
| Version comparison | No diff/compare control found in the version history UI | Standing **Diff** tab, unified diff between any two versions |
| Live/staging labels | `production` / `latest` labels on a version | `production` / `staging` **aliases** your app fetches at runtime |

## Sending a live call

Both need a real connected model before anything runs — neither offers a free trial
call. With that in place, both Playgrounds render the exact same reply from the exact
same inputs.

<details>
<summary>Show screenshots: Playground run on both platforms</summary>

![Langfuse Playground with the recreated prompt loaded, showing the real completion in the Output panel](/img/comparison/langfuse/lf-03-playground-run.png)
![AcruxCore Playground's Stored-prompt tab, showing the same completion plus a Gateway Telemetry panel with provider, cost, cache status, and latency](/img/comparison/acruxcore/acx-04-playground-run.png)

</details>

| Feature | Langfuse | AcruxCore |
|---|---|---|
| Playground | Runs against any connected model, no telemetry shown inline | Runs against a **stored prompt reference**, shows cost/cache/latency inline |
| Requires a real key | Yes | Yes |

## Tracing & observability

Same call, two different trace shapes. AcruxCore's trace is one span, written as a
side effect of the gateway call itself. Langfuse's is a two-level tree — a parent
span wrapping the generation — because its SDK instruments the call rather than
routing it.

<details>
<summary>Show screenshots: trace detail on both platforms</summary>

![Langfuse's trace detail: a two-node span tree (request span + generation span), 1.81s latency, $0.000048 cost, 154 total tokens](/img/comparison/langfuse/lf-04-trace-detail.png)
![AcruxCore's trace detail: one LLM span with model, provider, tokens, cost, and latency, linked back to the exact gateway request and prompt version](/img/comparison/acruxcore/acx-05-trace-detail.png)

</details>

| Feature | Langfuse | AcruxCore |
|---|---|---|
| Trace shape | Span tree (request + generation) | Single span per gateway call |
| How it's produced | Client-side OTel instrumentation | Automatic — a side effect of the gateway call |
| Links back to prompt version | Not surfaced in this run | Yes — "View traces for this prompt version" |

## Where the platform sits — in the request path, or beside it

AcruxCore's gateway sits **in the request path**: every call is routed through it, so
BYOK provider selection, caching, budgets, and virtual keys all apply before the
provider is ever called, and the trace is a side effect of that same hop. Langfuse
sits **beside** the request path — it ingests a trace *after* your own client made the
call — so there's nothing to route, cache, or budget against on its side. That's a
structural difference in what each product is, not something Langfuse does worse.

| Feature | Langfuse | AcruxCore |
|---|---|---|
| Where it sits | Beside the request path — call providers yourself, trace is reported after | In the request path — every call routes through it |
| BYOK, caching, budgets, virtual keys | Not applicable — no request path to apply them to | Built in, applied before the provider call |

## How tools are handled — schema registry, or execution

AcruxCore has a real **Tool Catalog** — callable functions, versioned like prompts,
with their own analytics page. Langfuse has nothing like it: the closest thing is a
"Create new tool" button tucked inside the Playground, which just defines a JSON
Schema for function-calling and saves it project-wide — we made one, reloaded the page
in a fresh window, and it was still there, offered back to us in the same combobox. So
it persists, but that's all it does: no catalog page, no list view outside that one
dropdown, no version history, no analytics, and nothing actually *executes* it —
Langfuse hands the schema to the model and stops there. AcruxCore's tools are wired
into the gateway, so a call is a real, traced execution with its own cost and latency,
not just a shape the model is told about.

<details>
<summary>Show screenshots: tool creation on Langfuse, tool analytics on AcruxCore</summary>

![Langfuse's Create LLM Tool dialog in the Playground, defining get_ticket_priority with a JSON Schema parameter](/img/comparison/langfuse/lf-13-tool-create.png)
![Langfuse's saved tool re-appearing in the Playground's tool picker after a full page reload, confirming it's stored project-wide, not per-session](/img/comparison/langfuse/lf-15-tool-persists.png)
![AcruxCore's Tool analytics page — call volume, error rate, and P50/P95 latency per tool, aggregated from traced executions](/img/comparison/acruxcore/acx-08-tool-analytics.png)

</details>

AcruxCore's Tools page — a dozen real, versioned tools including
`get_order_status`, `query_database`, and `get_weather` — is one sentence here; see the
[walkthrough](/blog/acruxcore-hands-on-walkthrough#7-a-versioned-tool-catalog) for the
screenshot.

| Feature | Langfuse | AcruxCore |
|---|---|---|
| Tool catalog | A schema saved from the Playground, reusable project-wide, but no dedicated page or list view | Persistent, versioned catalog with its own page |
| Execution | None — the schema is shown to the model, never run | Real, gateway-executed calls |
| Tool analytics | Not available | Calls, error rate, and latency per tool |

## Evaluation & datasets

Both build datasets and run experiments against them, but the on-ramp differs.
Langfuse lets you type a dataset item by hand or pull one from a trace; AcruxCore
builds datasets **only** from real feedback on a trace — and specifically, only from
**span-level** feedback, so a single-span trace's own thumbs-up can't be turned into a
dataset (we hit this directly and had to reuse a trace with more than one span).

<details>
<summary>Show screenshots: dataset item and experiment result on Langfuse</summary>

![Langfuse's Create dataset item dialog, with the flattened input variables and a hand-written expected output](/img/comparison/langfuse/lf-06-dataset-item.png)
![Langfuse's experiment result row: real input/output pairs, but Total Cost showing $0.00 for a custom model without registered pricing](/img/comparison/langfuse/lf-08-experiment-result.png)

</details>

AcruxCore's dataset (built from trace feedback) and its experiment run report are one
sentence each here; see the walkthrough's
[dataset](/blog/acruxcore-hands-on-walkthrough#5-build-a-dataset-from-real-feedback) and
[run-history](/blog/acruxcore-hands-on-walkthrough#6-check-the-run-history) sections
for the screenshots.

| Feature | Langfuse | AcruxCore |
|---|---|---|
| Dataset creation | Manual entry, API, or from a trace | From trace feedback only — and only **span-level** feedback |
| Experiments | Prompt × model matrix, evaluator step in the wizard | Version × model sweep with an automatic baseline |
| Cost accounting we actually saw | $0.00 for an unregistered custom model | Real per-call cost, computed inline |

## SDK & developer experience

Same call, two SDK philosophies. AcruxCore's SDK has dedicated surfaces —
`hub.prompts.render()` then `hub.gateway.chat()` — and the trace is automatic.
Langfuse wraps a client you already own; the trace only appears once you open an
explicit observation context around the call.

```python title="acx_sdk_run.py"
rendered = await hub.prompts.render("vip-support-triage", "production", VARIABLES)
result = await hub.gateway.chat(
    rendered.model, rendered.messages,
    temperature=0, max_tokens=256,
    prompt_version_id=rendered.version_id,
)
```

```python title="lf_trace_run.py"
with langfuse.start_as_current_observation(name="vip-support-triage-request", as_type="span"):
    response = client.chat.completions.create(
        model="openai/gpt-4o-mini",
        messages=[{"role": "system", "content": system_prompt},
                  {"role": "user", "content": user_message}],
    )
```

Both produced a real trace within seconds of the call returning:

<details>
<summary>Show screenshot: SDK-produced trace on Langfuse</summary>

![Langfuse's trace for the script-generated call: same VIP reply, 1.81s latency, $0.000048, OpenTelemetry SDK metadata visible](/img/comparison/langfuse/lf-09-sdk-trace.png)

</details>

Full scripts: [`acx_sdk_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/blogs/acruxcore-vs-langfuse/python/acx_sdk_run.py) and [`lf_trace_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/blogs/acruxcore-vs-langfuse/python/lf_trace_run.py).

AcruxCore's SDK-produced trace is one sentence here; see the
[walkthrough](/blog/acruxcore-hands-on-walkthrough#doing-this-from-code) for the
screenshot.

| Feature | Langfuse | AcruxCore |
|---|---|---|
| SDK model | Wrap your own client (`langfuse.openai`) | Dedicated `hub.prompts` / `hub.gateway` surface |
| Getting a trace | Requires an explicit observation context | Automatic side effect of `hub.gateway.chat()` |

## Latency overhead — measured

Langfuse's overhead is client-side instrumentation; ours is an extra network hop that
buys routing, caching and budgets. Those are two different kinds of cost, so this is not
a head-to-head — it is two numbers measured the same way, in the same run.

Both come from our
[full-cycle benchmark](/blog/full-cycle-latency-benchmark): eight paths interleaved in
rotating order, 100 rounds each, repeated four independent times, with **every leg ending
at `gpt-4o-mini` on `api.openai.com`**. It times the *full cycle* — resolve or fetch the
stored prompt, then complete it — rather than the completion alone, which is the honest
unit when a platform needs two round trips to answer one request.

The last column is the one that decides each row. A gap only counts if its 95%
confidence interval stays clear of zero. When the interval contains zero, "no
difference at all" is one of the answers the data allows — so the gap is noise with a
number attached, not a measurement.

| Path | median | gap vs. baseline | 95% CI | Distinguishable from zero? |
|---|--:|--:|---|:--:|
| OpenAI direct (baseline) | 978 ms | — | — | — |
| Langfuse OTel SDK | 954 ms | −22 ms | [−95, +84] | No |
| AcruxCore BYOK (gateway-free) | 1022 ms | +39 ms | [−1, +155] | No |
| AcruxCore gateway | 1032 ms | +63 ms | [−19, +172] | No |

Every interval here contains zero, so no row is a result. That includes Langfuse's
−22 ms: it is a sample artifact, **not** evidence that wrapping a client is faster than
calling OpenAI directly. Read those three rows as "too small to measure in this run".

On a call that already takes about a second, neither Langfuse's instrumentation nor our
gateway hop is something a user would feel — and the baseline's own p99 (6402 ms) is
worse than either platform's, which is a useful reminder that raw OpenAI with nothing in
front of it has the widest tail here.

That benchmark ran four times precisely because one 100-round run against a live
third-party API is not enough to trust a single figure. All 800 rounds are plotted in the
[full write-up](/blog/full-cycle-latency-benchmark).

## Friction hit during this run

Real friction hit while doing this comparison, not a symmetric wish list.

**Langfuse**
- 👍 Self-hosting was fast — one `docker compose up`, working on first login.
- 👍 The experiment wizard validates your dataset variables against the prompt *before* it spends a call.
- 👎 Flat templating pushed the VIP-branch and ticket-list logic back onto the caller (see **Prompt authoring & versioning** above).
- 👎 The Playground doesn't produce a trace — only a scripted SDK call does.
- 👎 A doc example called `start_as_current_span`, which doesn't exist on SDK 4.14.1; the real method is `start_as_current_observation`.

**AcruxCore**
- 👍 Nothing to instrument — `hub.gateway.chat()` (or the Playground) writes the trace as a side effect, no wrapper client.
- 👍 Nunjucks conditionals and loops are real template logic, not something you flatten by hand first.
- 👎 A model with no registered per-1M rate shows a blank `—` cost instead of `$0` or an estimate, until you register one.

**Time-to-first-trace:** AcruxCore gets there on the first call with zero
tracing-specific code. Langfuse gets there too, but only through the SDK path, and only
after wrapping a client and opening an observation context.

## What Langfuse does that AcruxCore doesn't

Sourced from Langfuse's own dashboard, not from this post's earlier aspects — those
carry the same bias any of our own feature list would.

**Monitors — automated alerts on cost, quality, or latency, wired to Slack, Webhooks,
or GitHub Actions.** Set a threshold once and get notified when a metric moves outside
it, with the notification routed to a channel your team already watches. AcruxCore
has budgets that cut off spend, but no equivalent alerting surface across cost,
quality, and latency together.

<details>
<summary>Show screenshot: Monitors & alerts setup on Langfuse</summary>

![Langfuse's Monitors setup: "Catch issues before they impact your users," with Connect Slack / Connect Webhooks / Connect GitHub Actions options and a Create Monitor button](/img/comparison/langfuse/lf-17-monitors-alerts.png)

</details>

We also checked for SSO/SCIM, expected from the pricing page's Enterprise tier — this
self-hosted organization's Settings has no SSO or SCIM section at all, consistent with
it being a paid-plan feature rather than something to demo locally.

## Is AcruxCore a Langfuse alternative?

For the prompt-and-call half of the job, yes. Langfuse has no request-path gateway, so
routing, caching, budgets and rate limits have no call to act on; its "tool" is a JSON schema
saved from a Playground dropdown that never executes; and its datasets are hand-authored or
pulled from a trace rather than built from feedback your users already gave.

For observability on its own, Langfuse is more mature than we are, with a much larger
framework-integration surface and threshold alerting we do not have. RBAC and audit sit
behind its paid tiers, which is worth checking against your own plan before comparing.

If you want the gateway but would rather keep Langfuse for tracing, that works: we accept
OTel-instrumented traces directly on an OTLP endpoint.

## Verdict

| | Langfuse | AcruxCore |
|---|---|---|
| Strongest at | Tracing depth, org/project structure, threshold alerting | A request-path gateway with routing, caching, and budgets on every call; tools that actually execute and get measured, not just described; datasets built straight from real production feedback |
| Weakest at | No request-path gateway; tools are a schema in a Playground dropdown, not a catalog; RBAC and audit gated behind paid tiers | No cost/quality/latency alerting |
| Pick it if | You want mature, OTel-native observability layered onto a client you already own, with automated alerting | You want the provider call itself — gateway, tools, feedback-driven datasets, and a rule-based judge scoring live traffic — traced for free, with nothing bolted on after the fact; AcruxCore also takes your own OTel-instrumented traces directly via its OTLP endpoint |

Tracing depth and threshold-based alerting are real Langfuse wins (**Tracing &
observability** and **What Langfuse does that AcruxCore doesn't** above). But on the
three things that make up the actual day-to-day loop of running an LLM app — the
gateway, the tool catalog, and building datasets from feedback — this comparison came
down in AcruxCore's favor every time, not just "different shape." Langfuse has no
request-path gateway at all (**Where the platform sits** above), its "tool" is a
schema saved from a Playground dropdown that's never actually executed (**How tools
are handled** above), and its datasets are built by hand or pulled from a trace, not
generated from feedback your users already gave (**Evaluation & datasets** above).
AcruxCore does all three natively, in one integrated flow. See the full picture,
including license, pricing, and team structure, on the
[compare page](https://acruxcore.com/compare).

Want to run this yourself? The [Quickstart](/docs/getting-started/quickstart) gets you
from sign-up to a traced, gateway-routed call in about ten minutes.
