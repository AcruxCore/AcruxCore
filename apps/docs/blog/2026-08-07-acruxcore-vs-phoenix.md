---
title: "Phoenix vs AcruxCore: OpenTelemetry-native tracing, tested against a request-path gateway"
description: We rebuilt the same support-triage prompt on Arize Phoenix and AcruxCore and ran the identical sequence on both — real screenshots, a real SDK trace, and a measured latency benchmark, not a feature table copied from docs.
slug: acruxcore-vs-phoenix
authors: [acrux]
tags: [comparison, phoenix, llm-ops, tracing]
image: /img/social-card.png
keywords: [phoenix vs AcruxCore, arize phoenix alternative, llm ops comparison, prompt versioning, ai gateway, llm tracing, openinference]
---

Arize Phoenix is the OTel-native tracing-and-eval project a lot of teams reach for
first, so it deserves a real answer, not a table copied from two docs sites. We built
the same prompt — `vip-support-triage`, a support agent that changes tone for VIP
customers and lists their open tickets — on both platforms, then ran the identical
sequence on each: create the prompt, version it, send a live call, inspect the trace,
build a dataset, run an experiment, and call it from an SDK script.

<!-- truncate -->

:::note[Same example, both sides]
Every paired screenshot below comes from the exact same prompt and the exact same
customer message, sent through the exact same downstream model
(`openai/gpt-4o-mini` via OpenRouter, configured as a Custom AI Provider in Phoenix) on
both platforms. Where a step is genuinely one-sided — no equivalent screen exists on
the other product — we say so instead of padding it out. License, pricing, team
structure, and community stats live on the [compare page](https://acruxcore.com/compare) instead of
here — they were always tables, and a price change there is one edit instead of three.
:::

### At a glance

| Aspect | Phoenix | AcruxCore | Winner |
|---|---|---|---|
| Tracing depth | Single span, OTel semantic conventions, rich attribute tabs | Single automatic span | Phoenix |
| Prompt templating | Mustache — `{{#section}}` doubles as both if *and* for | Real nunjucks `{% if %}` / `{% for %}` logic | AcruxCore |
| Playground | Cost, tokens, latency shown inline | Cost, cache, latency shown inline | Tie |
| Request-path gateway | None — Playground calls proxy through a GraphQL mutation, SDK calls go direct | Built in — routing, caching, budgets | AcruxCore |
| Tool catalog | Ad-hoc per-prompt tool JSON, no catalog page | Versioned catalog, real executed calls, analytics | AcruxCore |
| Dataset creation | From a trace span, or manually | From real span-level trace feedback | Tie |
| SDK trace capture | Instrument a client + call the provider yourself | Automatic side effect of the gateway call | AcruxCore |
| Measured overhead | -68ms (indistinguishable from zero) | +72ms (indistinguishable from zero) | Tie |
| Time-to-first-trace | SDK setup (register + instrument) before anything lands | Zero code, first gateway call | AcruxCore |

License, pricing, team structure, security, and community stats: see
[AcruxCore vs Phoenix on the compare page](https://acruxcore.com/compare).

Full breakdown, screenshots, and the verdict below.

## Tracing & observability

Same call, genuinely richer trace UI on Phoenix's side. Its Info/Attributes/Events
tabs, per-span cost and token counts, and OTel semantic-convention attributes gave us
more to look at than AcruxCore's single-span view — deserved credit even though this
is the comparison's own template.

<details>
<summary>Show screenshots: trace detail on both platforms</summary>

![Phoenix's trace detail: ChatCompletion span showing status, total cost, latency, and the full input/output messages — including the "- #: " blank ticket line from the Playground's flat-input bug](/img/comparison/phoenix/px-05-trace-detail.png)
![AcruxCore's trace detail: one LLM span with model, provider, tokens, cost, and latency, linked back to the exact gateway request and prompt version](/img/comparison/acruxcore/acx-05-trace-detail.png)

</details>

| Feature | Phoenix | AcruxCore |
|---|---|---|
| Trace shape | Single span, rich attribute/event tabs | Single span per gateway call |
| How it's produced | Client-side OTel instrumentation (Playground calls proxy through Phoenix's own GraphQL backend) | Automatic — a side effect of the gateway call |
| Links back to prompt version | Not surfaced in this run | Yes — "View traces for this prompt version" |

## Prompt authoring & versioning

Phoenix's Prompts feature only exists inside the Playground — there is no standalone
"create prompt" form, you build it live and save it from there. Its templating engine
is **Mustache**, selectable alongside F-String and no-templating. Mustache has no
separate if-statement: `{{#is_vip}}...{{/is_vip}}` is the *same* section syntax used
for looping over `tickets`, so a truthy scalar and an array are handled by one
construct, not two. That's a real difference from nunjucks, where `{% if %}` and
`{% for %}` are distinct.

<details>
<summary>Show screenshots: prompt editor, detail, and diff view</summary>

![Phoenix's Playground with the vip-support-triage prompt loaded, showing Mustache section syntax for the VIP conditional and the tickets loop, tagged "production", with real cost/token/latency telemetry from a live run](/img/comparison/phoenix/px-01-prompt-editor.png)
![Phoenix's prompt detail page — version 1 tagged "production" in the Latest Versions panel, separate from the prompt-level Labels field which reads "No Labels"](/img/comparison/phoenix/px-02-prompt-detail.png)
![Phoenix's version diff view — a second version highlighted in green for the one added line, with the version list and its "staging" tag alongside](/img/comparison/phoenix/px-03-diff-tab.png)
![AcruxCore's Diff tab showing a real unified diff between prompt version 2 and version 3](/img/comparison/acruxcore/acx-03-diff-tab.png)

</details>

AcruxCore's own prompt editor — real nunjucks conditionals and loops rendering VIP
status and the ticket list inline — is one sentence here rather than another
screenshot; see the [walkthrough](/blog/acruxcore-hands-on-walkthrough#2-create-a-prompt-version-it-and-promote-an-alias)
for the picture.

Phoenix also has a real, separate diff view between versions — we didn't expect that
going in. But it exposed a structural gap: the Playground's input fields are flat text
boxes. Typing a JSON array into the `tickets` field for the Mustache loop to consume
doesn't parse it — Mustache treats the whole string as one truthy value, the loop runs
once with no bound fields, and the ticket lines render blank (`- #: `) with no error.
The SDK renders it correctly (see **SDK & DX** below) because there the array is a real
Python list, not a string typed into a box — so this is a Playground-input limitation,
not a templating-engine one.

| Feature | Phoenix | AcruxCore |
|---|---|---|
| Conditional templating | Mustache sections — same syntax for if and for, verified hands-on | Real nunjucks `{% if %}`/`{% for %}`, rendered server-side |
| Version comparison | Real **Diff** toggle between any two versions | Standing **Diff** tab, unified diff between any two versions |
| Live/staging labels | `production` / `staging` **tags** on a version | `production` / `staging` **aliases** your app fetches at runtime |
| Structured variables in Playground | Flat text input only — arrays/objects don't parse, fail silently | Typed variable schema |

## Sending a live call

Both need a real connected model before anything runs. Phoenix required one extra
setup step: OpenAI-compatible providers with a custom base URL live under **Custom AI
Providers**, separate from the built-in OpenAI/Anthropic/Bedrock/Gemini list, and we
had to switch its API Type from "Responses" to "Chat Completions" for OpenRouter to
accept the request.

<details>
<summary>Show screenshots: Playground run on both platforms</summary>

![Phoenix's Playground run: the saved vip-support-triage prompt, Mustache inputs filled in, and a real completion with 1.9s latency, 122 tokens, and <$0.01 cost shown inline](/img/comparison/phoenix/px-04-playground-run.png)
![AcruxCore Playground's Stored-prompt tab, showing the same completion plus a Gateway Telemetry panel with provider, cost, cache status, and latency](/img/comparison/acruxcore/acx-04-playground-run.png)

</details>

| Feature | Phoenix | AcruxCore |
|---|---|---|
| Playground | Runs against a saved prompt version, cost/tokens/latency shown inline | Runs against a **stored prompt reference**, shows cost/cache/latency inline |
| Custom OpenAI-compatible providers | Yes — separate "Custom AI Providers" section, needs the right API Type set | Native — any OpenAI-compatible base URL |

## Where the platform sits — in the request path, or beside it

AcruxCore's gateway sits **in the request path**: every call is routed through it, so
BYOK provider selection, caching, budgets, and virtual keys all apply before the
provider is ever called. Phoenix sits **beside** the request path, on purpose — its
Playground's "Run" button doesn't call the provider from your browser at all; network
inspection during a real run showed the call going out as a single `POST /graphql` to
Phoenix's own backend, a UI-only relay with no routing, caching, or budget logic
behind it. Its SDK path (see **SDK & DX** below) skips that relay entirely and calls
the provider directly. That's a legitimate design choice — it works with any provider
without changing your call site — not a missing feature.

| Feature | Phoenix | AcruxCore |
|---|---|---|
| Where it sits | Beside the request path — Playground proxies via GraphQL, SDK calls go direct | In the request path — every call routes through it |
| BYOK, caching, budgets, virtual keys | Not applicable — no persistent request path to apply them to | Built in, applied before the provider call |

## How tools are handled — schema registry, or execution

AcruxCore has a real **Tool Catalog** — callable functions, versioned like prompts,
with their own analytics page. Phoenix has no equivalent nav item at all: the closest
thing is a "+ Tool" control inside the Playground's message editor, which defines a
JSON Schema function for that one prompt run. There's no catalog, no versioning, and
nothing gets executed or measured — the schema is registered, never run.

<details>
<summary>Show screenshot: tool analytics on AcruxCore</summary>

![AcruxCore's per-tool analytics: volume, error rate, and P50/P95 latency](/img/comparison/acruxcore/acx-08-tool-analytics.png)

</details>

AcruxCore's Tools page — a dozen versioned tools with real execution history — is one
sentence here; see the
[walkthrough](/blog/acruxcore-hands-on-walkthrough#7-a-versioned-tool-catalog) for the
screenshot.

| Feature | Phoenix | AcruxCore |
|---|---|---|
| Tool definition | Ad-hoc JSON Schema per prompt, in the Playground | Versioned catalog entry, reusable across prompts |
| Execution & analytics | Not found | Real executed calls, volume/error-rate/P50-P95 per tool |

## Evaluation & datasets

Phoenix's dataset flow starts from a real trace: select a span, "Add to Dataset,"
name it, done — genuinely as smooth as AcruxCore's. Its Evaluators page also draws a
clear diagram distinguishing **LLM evaluators** (AI-judged) from **Code evaluators**
(deterministic checks like `exact_match` and regex) — a distinction AcruxCore doesn't
surface as its own category, worth crediting.

Running an experiment against that dataset is where it broke down: the dataset stored
the span's *rendered* `messages` array, not the original template variables
(`company`, `is_vip`, `tickets`, `question`). Pointing the experiment at our saved
prompt produced "Dataset is missing input for variables" — the captured example and
the templated prompt don't speak the same shape without manual remapping.

<details>
<summary>Show screenshots: evaluators overview and the failed experiment run</summary>

![Phoenix's Evaluators overview diagram: Dataset → Task (Playground Prompt) → Evaluator (LLM or Code) → Score](/img/comparison/phoenix/px-12-evaluators-overview.png)
![Phoenix's experiment view over the new dataset — the saved prompt selected, but "Dataset is missing input for variables: company, is_vip, tickets, question" because the dataset stored rendered messages, not template variables](/img/comparison/phoenix/px-11-experiment-run.png)

</details>

AcruxCore's dataset (built from trace feedback) and its experiment run report are one
sentence each here; see the walkthrough's
[dataset](/blog/acruxcore-hands-on-walkthrough#5-build-a-dataset-from-real-feedback)
and
[run-history](/blog/acruxcore-hands-on-walkthrough#6-check-the-run-history)
sections for the screenshots.

| Feature | Phoenix | AcruxCore |
|---|---|---|
| Dataset from a trace | Yes — select a span, add to dataset | Yes — from real span-level trace feedback |
| Evaluator types | LLM evaluators and deterministic Code evaluators, distinct paths | LLM-judged evaluation |
| Running a templated prompt against a trace-sourced dataset | Broke — dataset stores rendered messages, not template variables | Not attempted in this comparison |

## SDK & DX

AcruxCore's SDK renders a *stored* prompt server-side
(`hub.prompts.render()`) and the gateway writes the trace with no tracing code in the
caller at all. Phoenix's Python SDK has no equivalent render call — there's no
server-side templating endpoint to hit, so the Mustache logic built in the Playground
had to be **hand-duplicated in Python** in our script. The upside: once instrumented,
`OpenAIInstrumentor` auto-wraps the OpenAI client and the trace lands correctly —
including the ticket loop rendering right, unlike the Playground's flat-input bug,
because here `tickets` is a real Python list.

```python
from phoenix.otel import register
from openinference.instrumentation.openai import OpenAIInstrumentor
from openai import OpenAI

tracer_provider = register(
    endpoint="http://localhost:6006/v1/traces",
    project_name="vip-support-triage-sdk",
)
OpenAIInstrumentor().instrument(tracer_provider=tracer_provider)

client = OpenAI(api_key=OPENROUTER_KEY, base_url="https://openrouter.ai/api/v1")
# system message rendered by hand — Phoenix has no server-side prompt-render call
```

Full script:
[`px_trace_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/phoenix-vs-acruxcore/python/px_trace_run.py).
AcruxCore's leg:
[`acx_sdk_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/phoenix-vs-acruxcore/python/acx_sdk_run.py).

<details>
<summary>Show screenshot: SDK-produced trace on Phoenix</summary>

![Phoenix's trace produced by the SDK script — the system message's ticket loop rendering correctly ("- #4821: ...", "- #4790: ...") because tickets is a real Python list, not a flat text box](/img/comparison/phoenix/px-09-sdk-trace.png)

</details>

AcruxCore's SDK-produced trace, with prompt-version lineage attached automatically, is
one sentence here; see the
[walkthrough](/blog/acruxcore-hands-on-walkthrough#doing-this-from-code) for the
screenshot.

| Feature | Phoenix | AcruxCore |
|---|---|---|
| Prompt rendering | No server-side render call — caller re-implements the template logic | `hub.prompts.render()` — one call, server-side |
| Tracing | Manual instrument step (`register` + `OpenAIInstrumentor`), then automatic | Automatic side effect of `hub.gateway.chat()`, zero tracing code |

## Latency overhead — measured

100 interleaved rounds, three legs, rotating order, warm-up discarded — the same
method as every comparison in this series. `phoenix_otel` wraps a raw OpenAI client
with `openinference-instrumentation-openai`; `acx_gateway` is a raw POST to a local
AcruxCore gateway. Both are compared against a direct baseline call to OpenRouter.

| Path | Median | P95 | P99 |
|---|---|---|---|
| OpenRouter direct (baseline) | 918ms | 1327ms | 1547ms |
| Phoenix OTel SDK | 855ms | 1389ms | 2007ms |
| AcruxCore gateway | 1010ms | 1629ms | 2247ms |

| Path | Median gap vs baseline | 95% CI |
|---|---|---|
| Phoenix OTel SDK | -68ms | [-166, 102]ms — **crosses zero, not distinguishable from noise** |
| AcruxCore gateway | +72ms | [-31, 201]ms — **crosses zero, not distinguishable from noise** |

Neither overhead is statistically real at this sample size — both confidence intervals
straddle zero. That's the honest result: client-side OTel instrumentation and an extra
network hop are different kinds of cost (CPU/serialization vs routing-and-caching
capability), but at 100 rounds, network noise swamps both. Full script:
[`latency_bench.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/phoenix-vs-acruxcore/python/latency_bench.py).

## Friction hit during this run

Setting up the Custom AI Provider was straightforward once we found it under
Settings → AI Providers rather than the API Keys popover. Real friction we hit in this
run: the Playground's flat-text variable inputs silently mis-render structured data
(see **Prompt authoring & versioning** above); a dataset built from a trace can't drive
an experiment against a templated prompt without remapping (see **Evaluation &
datasets** above); and visiting `/account` on this no-auth local install crashes with
"Something went wrong" rather than a graceful empty state.

| Feature | Phoenix | AcruxCore |
|---|---|---|
| Time-to-first-trace | Requires `register()` + `instrument()` before any call | Zero code — first gateway call traces itself |
| Custom provider setup | Real feature, one extra field (API Type) to get right | Native BYOK, no extra step |

## What Phoenix does that AcruxCore doesn't

Sourced from Phoenix's own dashboard and docs, not from this post's earlier aspects —
those carry the same bias any of our own feature list would.

**PXI, a built-in assistant docked in the dashboard.** A chat panel lives in every
Phoenix page, seeded with suggestions like "Find critical issues" and "Explain a
concept," and it can answer questions about your own traces, not just about Phoenix in
general. AcruxCore has no equivalent — no in-dashboard assistant at all.

<details>
<summary>Show screenshot: PXI, Phoenix's built-in assistant</summary>

![Phoenix's "Meet PXI, your Phoenix assistant" panel, with suggested prompts (How do I use Phoenix?, Explain a concept, Find critical issues) and a Tracing settings section controlling whether the assistant's own sessions are saved](/img/comparison/phoenix/px-13-ask-pxi.png)

</details>

**Per-project data retention on a schedule, plus typed annotation configs.** Project
Settings lets you set a retention policy with an actual schedule (this instance's
default runs "At 12:00 AM, only on Sunday (UTC)"), and define named annotation types
(here, a Categorical `user_feedback` config) rather than a single free-form rating.
AcruxCore's payload capture is one team-wide on/off switch; it has no per-project
retention schedule and no typed-annotation configuration.

<details>
<summary>Show screenshot: per-project retention and annotation config on Phoenix</summary>

![Phoenix's per-project Config tab: a retention policy with a real schedule, and an Annotation Configs table defining a Categorical "user_feedback" type](/img/comparison/phoenix/px-14-project-config.png)

</details>

One earlier expectation didn't hold up: Phoenix's docs list Tracing, Evaluation, Prompt
Engineering, Datasets & Experiments, and PXI as its top-level capabilities today — no
embedding-drift-analysis section turned up in the docs nav or in this instance's UI, so
we're not carrying that claim forward from older material.

## Verdict

| | Phoenix | AcruxCore |
|---|---|---|
| Strongest at | Rich per-span trace attributes, a genuine LLM-vs-code evaluator split, a built-in dashboard assistant | A request-path gateway with routing, caching, and budgets on every call; tools that actually execute and get measured; server-side prompt rendering with zero tracing code |
| Weakest at | No request-path gateway; no team/RBAC/audit at all in local OSS; Playground's flat inputs silently mis-render structured template data | No in-dashboard assistant; narrower eval-evaluator taxonomy; audit scoped per-prompt |
| Pick it if | You want OTel-native tracing and evals layered onto a client you already own, and don't need team/RBAC out of the box | You want the provider call itself — gateway, tools, feedback-driven datasets — traced for free, with a real team model, nothing bolted on after the fact |

Phoenix's tracing depth and its LLM/code evaluator split (**Tracing & observability**,
**Evaluation & datasets** above) are real strengths, and so is PXI, its built-in
assistant (**What Phoenix does that AcruxCore doesn't**). But on the loop that
actually runs a production LLM app day to day, this comparison landed on AcruxCore's
side each time: Phoenix has no request-path gateway at all (**Where the platform sits**
above), its "tool" is an unversioned JSON Schema saved per-prompt, never executed or
measured (**How tools are handled** above), and its local OSS install has no team,
role, or audit concept whatsoever. AcruxCore does all three natively, in one
integrated flow. See the full picture, including license, pricing, and team structure,
on the [compare page](https://acruxcore.com/compare).

Want to run this yourself? The [Quickstart](/docs/getting-started/quickstart) gets you
from sign-up to a traced, gateway-routed call in about ten minutes.
