---
title: "Opik vs AcruxCore: guardrails, PII detection, and online evaluation, put to the test"
description: We rebuilt the same support-triage prompt on self-hosted Opik and AcruxCore and ran the identical sequence on both — real screenshots, a real SDK trace, and a measured latency benchmark, not a feature table copied from docs.
slug: acruxcore-vs-opik
authors: [acrux]
tags: [comparison, opik, llm-ops]
image: /img/social-card.png
keywords: [opik vs AcruxCore, opik alternative, llm ops comparison, prompt versioning, ai gateway, llm tracing, comet opik]
---

Opik is Comet's open-source LLM-ops platform, and unlike some competitors we've covered
it ships with genuinely no login wall when self-hosted — you `docker compose up` and
you're working inside a real workspace immediately. We built the same prompt —
`vip-support-triage`, a support agent that changes tone for VIP customers and lists
their open tickets — on both platforms, then ran the identical sequence on each: create
the prompt, version it, send a live call, inspect the trace, build a dataset, run an
experiment, and call it from an SDK script.

<!-- truncate -->

:::note[Same example, both sides]
Every paired screenshot below comes from the exact same prompt and the exact same
customer message, sent through the exact same downstream model
(`openai/gpt-4o-mini` via OpenRouter) on both platforms. Opik's self-hosted instance
had no login screen and no credentials to configure, so this comparison was run as an
anonymous local user — exactly what a reader self-hosting it for the first time would
see. Where a step is genuinely one-sided — no equivalent screen exists on the other
product — we say so instead of padding it out. License, pricing, team structure, and
community stats live on the [compare page](https://acruxcore.com/compare) instead of here — they were
always tables, and a price change there is one edit instead of three.
:::

### At a glance

| Aspect | Opik | AcruxCore | Winner |
|---|---|---|---|
| Dataset creation | Add-to-dataset from any trace, inline dataset creation | From real span-level trace feedback | Depends |
| Prompt templating | Flat `{{variable}}` only, but real Diff view + environment labels | Real nunjucks `{% if %}` / `{% for %}` logic, real Diff tab | AcruxCore |
| Playground | Latency + tokens shown inline, no cost, no cache | Cost, cache, latency shown inline | AcruxCore |
| Tracing depth | Span tree via client-side SDK instrumentation | Single automatic span | Depends |
| Request-path gateway | None — ingests a trace after your own call | Built in — routing, caching, budgets | AcruxCore |
| Tool catalog | No catalog at all — "Agent playground" needs a live connected process | Versioned catalog, real executed calls, analytics | AcruxCore |
| SDK trace capture | Wrap a client with `track_openai()` | Automatic side effect of the gateway call | AcruxCore |
| Measured overhead | +102ms (real, CI does not cross zero) | +206ms (real, extra hop) | Opik |
| Time-to-first-trace | Only via the SDK path, after wrapping a client | Zero code, first call | AcruxCore |

License, pricing, team structure, security, and community stats: see
[AcruxCore vs Opik on the compare page](https://acruxcore.com/compare).

Full breakdown, screenshots, and the verdict below.

## Evaluation & datasets

Opik's "Add to → Dataset" works straight from a trace's detail panel — broader than a
span-only restriction we hit on another platform — and creating a brand-new dataset is
a one-step inline dialog from that same menu.

<details>
<summary>Show screenshot: Add to dataset dialog on Opik</summary>

![Opik's Add to dataset dialog, with a newly-created vip-support-triage-feedback dataset selected and the trace's nested spans, tags, feedback scores, and usage metrics all checked to copy in](/img/comparison/opik/op-07-dataset.png)

</details>

AcruxCore's dataset — built from a real feedback row, since the vip-support-triage
trace's own single-span feedback wasn't eligible — is one sentence here; see the
[walkthrough](/blog/acruxcore-hands-on-walkthrough#5-build-a-dataset-from-real-feedback)
for the screenshot.

Running an experiment against that dataset from the UI goes through "Open in
Playground" — the dataset's rows load as bindable variables
(`{{input.messages.1.content}}`-style paths), then Run. Clicking "Run an experiment"
directly instead explicitly says **"Use this dataset to run an experiment using the
Python SDK"** — confirming the SDK is the primary path for a scripted experiment, with
the Playground as the interactive alternative.

<details>
<summary>Show screenshot: dataset-bound experiment run in Opik's Playground</summary>

![Opik's Playground with the dataset loaded, a variant bound to the dataset's message field, and a real experiment result row showing the model's reply next to the dataset's expected output and feedback score](/img/comparison/opik/op-08-experiment-run.png)

</details>

AcruxCore's Run report for that dataset against gpt-4o-mini — a plain, unscored
manual run — is one sentence here; see the
[walkthrough](/blog/acruxcore-hands-on-walkthrough#6-check-the-run-history) for the
screenshot.

| Feature | Opik | AcruxCore |
|---|---|---|
| Dataset creation | From any trace directly, inline "create new dataset" in the same dialog | From trace feedback only — and only **span-level** feedback |
| Experiments | Interactive via Playground, or scripted via the Python SDK (UI explicitly defers to it) | Version × model sweep with an automatic baseline, run from the UI |
| Feedback scores | Thumbs-up/down "Human review," visible in the dataset row copied over | Span-level feedback, gates dataset eligibility |

## Prompt authoring & versioning

Opik's Prompt library offers a "text prompt" or a "chat prompt" — both are flat
`{{variable}}` substitution, confirmed hands-on: there is no `{% if %}` or `{% for %}`
anywhere. We flattened the VIP-branch note and the two-item ticket list into plain
text, the same way an earlier comparison had to for Langfuse, keeping only
`{{company}}` and `{{customer_message}}` as real variables.

<details>
<summary>Show screenshots: prompt editor and versions on both platforms</summary>

![Opik's New chat prompt dialog for the recreated vip-support-triage prompt, showing flat {{company}} and {{customer_message}} variable substitution with no conditional syntax available](/img/comparison/opik/op-01-prompt-editor.png)
![Opik's prompt detail page for v1, with Use, Deploy to, and Edit controls above the rendered system and user messages](/img/comparison/opik/op-02-versions.png)
![AcruxCore's Diff tab showing a real unified diff between prompt version 2 and version 3](/img/comparison/acruxcore/acx-03-diff-tab.png)

</details>

AcruxCore's own prompt editor — real nunjucks conditionals and loops rendering VIP
status and the ticket list inline — is one sentence here; see the
[walkthrough](/blog/acruxcore-hands-on-walkthrough#2-create-a-prompt-version-it-and-promote-an-alias)
for the picture.

Unlike a competitor we compared earlier that had no diff feature at all, Opik does have
a real version comparison — we edited the prompt to create v2 and used its "Diff"
button:

<details>
<summary>Show screenshot: version diff panel on Opik</summary>

![Opik's Compare v1 to v2 panel, showing the old system message in red strikethrough on the left and the new message in green on the right, side by side](/img/comparison/opik/op-03-diff-tab.png)

</details>

It also has an environment-labelling control ("Deploy to") that tags a specific
version as `production`, `staging`, or `development` — functionally close to Acrux
Core's aliases, just without the runtime "fetch by alias" SDK call:

<details>
<summary>Show screenshot: Deploy to / environment labels on Opik</summary>

![Opik's Deploy to menu, with v2 now tagged production via a green badge next to the version number](/img/comparison/opik/op-04-deploy-label.png)

</details>

| Feature | Opik | AcruxCore |
|---|---|---|
| Conditional templating | Flat `{{variable}}` only — verified hands-on, no `{% if %}`/`{% for %}` | Real nunjucks `{% if %}`/`{% for %}`, rendered server-side |
| Version comparison | Real "Diff" view, whole-message red/green (not word-level) | Standing **Diff** tab, unified word-level diff between any two versions |
| Live/staging labels | "Deploy to" tags a version `production`/`staging`/`development` | `production` / `staging` **aliases** your app fetches at runtime |

## Sending a live call

Opik's Prompt playground accepts OpenRouter directly as a named provider — paste a key,
search any OpenRouter-routed model by name. Both playgrounds produced the identical VIP
reply from the identical inputs.

<details>
<summary>Show screenshots: Playground run on both platforms</summary>

![Opik's Prompt playground with the recreated prompt loaded, openai/gpt-4o-mini selected via OpenRouter, and Output A showing the real completion with 1.9s latency and 163 tokens](/img/comparison/opik/op-05-playground-run.png)
![AcruxCore Playground's Stored-prompt tab, showing the same completion plus a Gateway Telemetry panel with provider, cost, cache status, and latency](/img/comparison/acruxcore/acx-04-playground-run.png)

</details>

| Feature | Opik | AcruxCore |
|---|---|---|
| Playground | Runs against any OpenRouter-routed model, shows latency + tokens inline, no cost | Runs against a **stored prompt reference**, shows cost/cache/latency inline |
| Requires a real key | Yes | Yes |

## Tracing & observability

Confirmed hands-on: running the prompt from Opik's Playground left the project's Logs
tab at "No traces yet" — the Playground alone does not trace, the same finding as an
earlier comparison. A real trace only appeared after calling the SDK-wrapped client,
producing a two-level span tree: an outer `chat_completion_create` trace wrapping an
inner LLM span with model, provider, tokens, and cost.

<details>
<summary>Show screenshots: trace detail on both platforms</summary>

![Opik's trace detail: a two-node span tree (outer trace + inner LLM span), 2.6s latency, <$0.01 cost, 138 total tokens, full system/user/assistant messages shown](/img/comparison/opik/op-06-trace-detail.png)
![AcruxCore's trace detail: one LLM span with model, provider, tokens, cost, and latency, linked back to the exact gateway request and prompt version](/img/comparison/acruxcore/acx-05-trace-detail.png)

</details>

| Feature | Opik | AcruxCore |
|---|---|---|
| Trace shape | Span tree (outer trace + inner LLM span) | Single span per gateway call |
| How it's produced | Client-side `track_openai()` wrapper | Automatic — a side effect of the gateway call |
| Playground produces a trace | No — confirmed, Logs stayed empty after a Playground run | Yes — every Playground run is traced |

## Where the platform sits — in the request path, or beside it

AcruxCore's gateway sits **in the request path**: every call is routed through it, so
BYOK provider selection, caching, budgets, and virtual keys all apply before the
provider is ever called, and the trace is a side effect of that same hop. Opik sits
**beside** the request path too — like the other observability-first platforms we've
compared, it ingests a trace *after* your own client made the call, so there's nothing
to route, cache, or budget against on its side.

| Feature | Opik | AcruxCore |
|---|---|---|
| Where it sits | Beside the request path — call providers yourself, trace is reported after | In the request path — every call routes through it |
| BYOK, caching, budgets, virtual keys | Not applicable — no request path to apply them to | Built in, applied before the provider call |

## How tools are handled — schema registry, or execution

Opik has no tool catalog concept at all. Its closest surface, "Agent playground," is
not a schema-definition UI — it's a **live-connection debugger**: you add
`@opik.track(entrypoint=True)` to a running agent's own code and run a connector
command in your terminal, and Opik waits for that process to connect.

<details>
<summary>Show screenshots: Agent playground on Opik, tool analytics on AcruxCore</summary>

![Opik's Agent playground showing Disconnected status and setup instructions to add @opik.track(entrypoint=True) to a running agent and run a connection command in the terminal](/img/comparison/opik/op-09-agent-playground-connect.png)
![AcruxCore's Tool analytics page — call volume, error rate, and P50/P95 latency per tool, aggregated from traced executions](/img/comparison/acruxcore/acx-08-tool-analytics.png)

</details>

With nothing connected, the page just sits at "Disconnected" showing setup copy — this
is weaker than even the placeholder "Create LLM Tool" schema dialog a prior
comparison found on another platform, since that at least produced a stored,
reusable JSON Schema object from the UI with zero code. AcruxCore's Tools page — a
dozen real, versioned tools — is one sentence here; see the
[walkthrough](/blog/acruxcore-hands-on-walkthrough#7-a-versioned-tool-catalog) for the
screenshot.

| Feature | Opik | AcruxCore |
|---|---|---|
| Tool catalog | None — no schema object, no list view, no per-tool page | Persistent, versioned catalog with its own page |
| Agent visibility | Requires a live process connected via code + terminal command | Real, gateway-executed calls, traced automatically |
| Tool analytics | Not available | Calls, error rate, and latency per tool |

## SDK & developer experience

Opik wraps a client you already own; the trace only appears once that wrapped client
makes a call. AcruxCore's SDK has dedicated surfaces — `hub.prompts.render()` then
`hub.gateway.chat()` — and the trace is automatic.

```python title="op_trace_run.py"
client = track_openai(
    OpenAI(api_key=OPENROUTER_KEY, base_url="https://openrouter.ai/api/v1"),
    project_name="Default Project",
)
response = client.chat.completions.create(
    model="openai/gpt-4o-mini", temperature=0, max_tokens=256,
    messages=[{"role": "system", "content": SYSTEM_PROMPT},
              {"role": "user", "content": USER_MESSAGE}],
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

Both produced a real trace within seconds of the call returning:

<details>
<summary>Show screenshot: SDK-produced trace on Opik</summary>

![Opik's trace for the script-generated call: 138 total tokens, <$0.01 cost, 2.6s latency, model and provider metadata visible on the span](/img/comparison/opik/op-06-trace-detail.png)

</details>

Full scripts: [`op_trace_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/opik-vs-acruxcore/python/op_trace_run.py) and [`acx_sdk_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/opik-vs-acruxcore/python/acx_sdk_run.py).

AcruxCore's SDK-produced trace is one sentence here; see the
[walkthrough](/blog/acruxcore-hands-on-walkthrough#doing-this-from-code) for the
screenshot.

| Feature | Opik | AcruxCore |
|---|---|---|
| SDK model | Wrap your own client (`track_openai(OpenAI(...))`) | Dedicated `hub.prompts` / `hub.gateway` surface |
| Getting a trace | Automatic once the wrapped client is called | Automatic side effect of `hub.gateway.chat()` |

## Latency overhead — measured

We timed the identical call three ways, interleaved in rotating order over 100 rounds
so a network blip hits all three equally: a raw direct call to OpenRouter (baseline),
the same call wrapped in Opik's `track_openai()` client, and the same call through
AcruxCore's gateway. This measures two different kinds of overhead — Opik's is
client-side instrumentation cost, AcruxCore's is an extra network hop that buys
routing and caching — not a rigged head-to-head.

| Path | median | p95 | p99 |
|---|---|---|---|
| Direct to provider | 979 ms | 1439 ms | 1627 ms |
| Opik tracked SDK | 1064 ms | 1350 ms | 1587 ms |
| AcruxCore gateway | 1184 ms | 1778 ms | 2247 ms |

With a 95% bootstrap confidence interval on the gap against the direct-call baseline:
Opik's **+102ms is real** (CI [+14, +191]ms) — it does not cross zero at this sample
size, unlike a competitor's client-side overhead we measured previously. AcruxCore's
**+206ms is also real** (CI [+123, +293]ms) — the cost of the extra hop, not a
measurement artifact.

Full script: [`latency_bench.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/opik-vs-acruxcore/python/latency_bench.py).

## Friction hit during this run

Real friction hit while doing this comparison, not a symmetric wish list.

**Opik**
- 👍 No login wall at all on self-host — straight into a working project.
- 👍 OpenRouter is a first-class named provider in the Playground, no custom-base-URL workaround needed.
- 👍 "Add to dataset" works directly from any trace, with inline "create new dataset" in the same dialog.
- 👎 The Prompt playground doesn't produce a trace — only a wrapped SDK call does.
- 👎 Running an experiment from a dataset explicitly defers to the SDK; the UI-only path is the Playground, not a real batch experiment runner.
- 👎 The Agent playground requires editing your own agent's code and running a terminal connector command just to see it — no schema-only path at all.

**AcruxCore**
- 👍 Nothing to instrument — `hub.gateway.chat()` (or the Playground) writes the trace as a side effect, no wrapper client.
- 👍 Nunjucks conditionals and loops are real template logic, not something you flatten by hand first.
- 👎 A model with no registered per-1M rate shows a blank `—` cost instead of `$0` or an estimate, until you register one.

**Time-to-first-trace:** AcruxCore gets there on the first call with zero
tracing-specific code. Opik gets there too, but only through the SDK path, after
wrapping a client.

## What Opik does that AcruxCore doesn't

Sourced from Opik's own dashboard and docs, not from this post's earlier aspects —
those carry the same bias any of our own feature list would.

**Guardrails — a Topic guardrail and a PII guardrail, configurable per project.**
Opik's "Set a guardrail" panel lets you enable a topic-restriction check (with a
sensitivity slider and a comma-separated restricted-topics list) and a PII check that
flags specific categories — credit card number, phone number, email, and more — each
with its own sensitivity threshold, plus a ready-to-run Python snippet using
`opik.guardrails`. AcruxCore has no equivalent: nothing inspects a call's input or
output for restricted topics or personal data before or after it reaches the model.

<details>
<summary>Show screenshot: guardrails panel on Opik</summary>

![Opik's "Set a guardrail" panel: Topic guardrail and PII guardrail toggles with sensitivity sliders, a restricted personal data checklist (credit card number, phone number checked), and a Python code sample using opik.guardrails](/img/comparison/opik/op-12-guardrails.png)

</details>

**Online evaluation — rules that score production traffic automatically.** The
"Online evaluation" page under Production lets you create a rule that scores every
matching trace as it arrives, rather than waiting for someone to run an experiment.
AcruxCore's evaluation is dataset-driven and on demand; nothing scores live traffic
without an explicit run.

<details>
<summary>Show screenshot: online evaluation on Opik</summary>

![Opik's "No online evaluations yet" empty state under Online evaluation, with "Create a rule to automatically score your model's outputs" and a Create your first rule button](/img/comparison/opik/op-13-online-evaluation.png)

</details>

**Test suites — a dedicated pre-deployment regression object.** Distinct from
Experiments: import test cases from a CSV or JSON file, or define them in the SDK,
each with an expected output and a scoring method, framed by Opik itself as
regression testing rather than dataset-driven experimentation.

<details>
<summary>Show screenshot: Test suites on Opik</summary>

![Opik's empty Test suites page, offering Upload a file (CSV/JSON) or Use SDK as the two ways to define test cases with expected outputs and scoring](/img/comparison/opik/op-11-test-suites.png)

</details>

AcruxCore has no equivalent to any of the three — no guardrails, no standing
online-scoring rule, and no separate pre-deployment test-suite object. Its evaluations
are dataset × model experiments, run on demand.

## Verdict

| | Opik | AcruxCore |
|---|---|---|
| Strongest at | Guardrails and PII detection, online evaluation on live traffic, dedicated test suites, self-host with zero setup friction, real diff/deploy on prompts | A request-path gateway with routing, caching, and budgets on every call; tools that actually execute and get measured; datasets built from real feedback |
| Weakest at | No tool catalog at all; experiments default to the SDK, not the UI; Playground doesn't produce a trace | No guardrails, no standing online-scoring rule, no dedicated test-suite object |
| Pick it if | You want guardrails, online scoring, and regression test suites layered onto a client you already own | You want the provider call itself — gateway, tools, feedback-driven datasets — traced for free, with nothing bolted on after the fact |

Opik's guardrails, online evaluation, and test suites (**What Opik does that AcruxCore
doesn't** above) are real, and none of the four are things AcruxCore has an answer
for today. But on the loop that runs a production LLM app day to day, this comparison
landed on AcruxCore's side: Opik has no tool catalog at all (**How tools are handled**
above), and its Playground doesn't produce a trace, only a wrapped SDK call does
(**Tracing & observability** above). AcruxCore's gateway, tool catalog, and
feedback-driven datasets stay in one integrated flow. See the full picture, including
license, pricing, and team structure, on the [compare page](https://acruxcore.com/compare).

Want to run this yourself? The [Quickstart](/docs/getting-started/quickstart) gets you
from sign-up to a traced, gateway-routed call in about ten minutes.
