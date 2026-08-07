---
title: "LangSmith vs Langfuse vs PromptLayer vs AcruxCore: a hands-on comparison"
description: We logged into all four hosted products ourselves — created prompts, ran live model calls, inspected traces, and ran real evals — instead of comparing marketing pages.
slug: hands-on-llm-ops-comparison
authors: [acrux]
tags: [comparison, langsmith, langfuse, promptlayer, walkthrough, llm-ops]
image: /img/social-card.png
keywords: [langsmith vs langfuse, langsmith vs promptlayer, llm ops comparison, prompt management comparison, llm tracing comparison, llm evaluation comparison]
---

Most tool comparisons are written from docs and marketing pages. We didn't do that here.
We logged into the real, hosted versions of **LangSmith**, **Langfuse**, and **PromptLayer**
with real accounts, plus our own **AcruxCore** as the baseline, and did the same thing on
each one: create a prompt, version it, run it live (with a real OpenAI key, once we added
one to each account), inspect the resulting trace, and try to build an eval. Then we wrote
a small script against each platform's own SDK and ran that too.

Each platform gets its own detailed, screenshot-backed post — that's where the evidence
lives:

- [Hands-on with LangSmith](/blog/langsmith-hands-on-walkthrough)
- [Hands-on with Langfuse](/blog/langfuse-hands-on-walkthrough)
- [A hands-on walkthrough of PromptLayer](/blog/promptlayer-hands-on-walkthrough)
- [A hands-on walkthrough of AcruxCore](/blog/acruxcore-hands-on-walkthrough)

This post is the synthesis: what's actually different, what's genuinely unique to one
platform, and an honest read on where AcruxCore stands next to the other three.

<!-- truncate -->

:::note
This is a companion to our earlier [AcruxCore vs LangSmith](/blog/acrux-core-vs-langsmith)
post, which compared product *shape* from documentation. This one is narrower in scope
(LangSmith, Langfuse, PromptLayer only) but backed entirely by things we clicked, ran, and
screenshotted ourselves.
:::

## At a glance

The sections below go deep on each dimension with screenshots. If you just want the summary:

| Dimension | LangSmith | Langfuse | PromptLayer | AcruxCore |
|---|---|---|---|---|
| Prompt versioning | Git-like commits + Environments | Immutable versions + labels | Immutable versions + Release Labels + inline diff | Immutable versions + Aliases + Diff tab |
| Tracing | Span-based (SDK-wrapped) | Span-based (SDK-wrapped) | Flat Request Log by default; Traces are separate and opt-in | Span-based (gateway auto-traces every call) |
| Evaluation | Datasets + Experiments, hand-authored examples | Datasets + Experiments, hand-authored examples | A/B test on live traffic + ad-hoc model-comparison grid | Feedback-driven datasets only — no hand-authored examples |
| Feedback → Playground → save loop | Feedback + Dataset + Annotation Queue exist, but no trace → Playground jump | Full loop: trace → Playground (pre-loaded) → Save as prompt | Full loop: Request → Playground (pre-loaded) → Save Template | Full loop, plus an automated version: feedback → drafted candidates → judged run → Promote to production |
| Tool calling | Shows up as spans only; no catalog | Playground-scoped tool schema; no catalog | Per-request tool-call count; no catalog | Dedicated versioned Tool Catalog + a Tool analytics page |
| Developer experience | `wrap_openai` + `@traceable` around your own OpenAI call | Drop-in OpenAI wrapper, built on OpenTelemetry | `pl_client.openai` wrapper around your own OpenAI call | `hub.prompts.render` + `hub.gateway.chat` — no direct call to a provider at all, Node and Python |
| Pricing (what we actually saw) | Not verified hands-on | Not verified hands-on | Team Trial plan with visible quotas | Open source, free during public beta — no trial, no quota |

## Prompt management

All four tools landed on the same underlying idea — **immutable versions plus a movable
pointer** — just with different names and different amounts of ceremony around it.

| Platform | Versioning | "Which one is live" mechanism | Diff on save |
|---|---|---|---|
| LangSmith | Git-like commits with a hash per save | Named **Environments** (Production/Staging) | Not shown inline |
| Langfuse | Immutable versions | **Labels** (`production`/`latest`) | Not shown inline |
| PromptLayer | Immutable versions with commit messages | **Release Labels** attached to a version | Yes — colored line diff in the save dialog |
| AcruxCore | Immutable versions | **Aliases** (`production`/`staging`) | Yes — dedicated Diff tab on the prompt page |

Two things stood out. **PromptLayer auto-detects template variables** the moment you type
`{{variable}}` in a message — no separate step to declare it — and Langfuse does the same
for `{{variable}}` syntax while also supporting **Jinja-style `{% if %}` conditionals** in
one of its real production prompts, a level of logic beyond plain substitution. AcruxCore's
own prompt renderer is built on nunjucks (a Jinja2-compatible templating engine used across
this repo instead of a Python dependency), so the same conditional-logic capability is
already there — we just didn't happen to exercise it hands-on in this pass.

On promotion itself: we actually clicked "promote" and watched the alias move on AcruxCore
(`production` v1 → v2) and on PromptLayer (Release Label). LangSmith's Environments feature
exists but had nothing deployed on our test account, so we saw the UI, not a live promotion.

<details>
<summary>See the actual screens: prompt versioning on all four platforms</summary>

**LangSmith** — commit history with a hash per save, model config attached to the prompt:

![LangSmith prompt detail page showing two commits in the history and model configuration](/img/tutorials/langsmith-walkthrough/ls-02-prompt-versions.png)

**Langfuse** — immutable versions with `production`/`latest` labels, variables auto-detected:

![Langfuse prompt versions list showing v1 tagged production and v2 tagged latest](/img/tutorials/langfuse-walkthrough/lf-05-prompt-versions.jpg)

**PromptLayer** — a colored line diff shown right in the save dialog, plus Release Labels in the version history:

![PromptLayer save-new-version dialog showing a colored diff of the message changes](/img/tutorials/promptlayer-walkthrough/03-save-version-diff.png)
![PromptLayer version history panel showing versions with commit messages and a Release Label control](/img/tutorials/promptlayer-walkthrough/04-version-history-and-empty-traces.png)

**AcruxCore** — the prompt editor, the Versions tab after promoting `production` to v2, and the Diff tab:

![AcruxCore prompt editor showing version tabs including Editor, Preview, Versions, Diff, Audit](/img/tutorials/acruxcore-walkthrough/02-prompt-editor.png)
![AcruxCore Versions tab listing v2 tagged PRODUCTION and v1 tagged STAGING, each with a promote link and a View traces link](/img/tutorials/acruxcore-walkthrough/03-alias-promoted.png)
![AcruxCore's Diff tab showing a line-level, colored diff between prompt version 1 and version 2](/img/tutorials/acruxcore-walkthrough/04-diff-tab.png)

</details>

## Tracing and observability

This is where the four platforms split into two real camps, not just cosmetic differences.

**Span-based, multi-step tracing is the default** on LangSmith, Langfuse, and AcruxCore —
each shows a tree (parent run/trace with child spans), not just a single flat call record.
On LangSmith, a real trace showed a parent run containing a tool-call span and a separate
LLM-call span. On Langfuse, a trace groups a `chat-completion` generation under a
top-level trace, with session and user badges right on the header. On AcruxCore, every
gateway call is auto-traced as a span the moment it's routed through, with the SDK's
`trace()` available to wrap additional steps into the same tree.

**PromptLayer is the outlier.** Its default is a flat per-call **Request Log** — model,
latency, cost, tokens, no nested steps — and true multi-step **Traces** are a separate,
opt-in feature that stayed empty in our account even after several live model calls. Having
a model key configured unlocks *running* prompts; it does not populate Traces. You need
explicit SDK-level `trace_id`/span instrumentation for that, which we didn't set up.

One genuine surprise, on Langfuse specifically: **running the Playground does not create a
trace at all.** We confirmed zero new rows in Tracing immediately after a successful
Playground run — only real SDK/API-instrumented calls show up there. If you're evaluating
Langfuse by clicking around its Playground, you can easily conclude tracing "isn't working"
when it's actually just not wired to that particular button.

The structural reason AcruxCore's tracing needs no setup step at all is that the **gateway
sits in the request path** — your call physically routes through AcruxCore's servers, so
it's traced by construction. LangSmith and Langfuse, by contrast, trace by having their SDK
wrap or observe a call you still make directly to the provider yourself. Neither approach is
strictly "better" — the gateway model gives you tracing (and cost/routing control) for free
the moment you switch endpoints; the SDK-wrapper model works with any call path you already
have, gateway or not.

The obvious follow-up question is whether routing through the gateway costs you latency.
We [measured it](/blog/llm-gateway-overhead): the gateway's own software adds about 26 ms,
with the rest of what you'd see being ordinary network distance you control by deploying
close to your callers.

<details>
<summary>See the actual screens: trace views on all four platforms</summary>

**LangSmith** — a real span tree from a live run: parent chain, prompt-template spans, and the model call, with real latency and token count:

![LangSmith trace detail showing a RunnableSequence span tree feeding into a gpt-5.6-terra span, with latency and token count](/img/tutorials/langsmith-walkthrough/ls-live-02-trace-span-tree.png)

**Langfuse** — session and user badges live on the trace header, with cost/token breakdown inline:

![Langfuse trace detail panel showing session grouping, cost, token counts, and tags](/img/tutorials/langfuse-walkthrough/lf-03-trace-detail.jpg)

**PromptLayer** — the flat Request Log (what you get by default) versus Traces, which stayed empty even after a live model call:

![PromptLayer Request Log detail page for a live request, showing model, cost, and token counts](/img/tutorials/promptlayer-walkthrough/08-live-request-log-detail.jpg)
![PromptLayer Traces and Analytics page showing No traces found even after a live model call](/img/tutorials/promptlayer-walkthrough/09-live-traces-still-empty.jpg)

**AcruxCore** — a gateway call auto-traced as a span, with model/provider fields visible on the span itself:

![AcruxCore trace detail page showing 1 span, token count, and status OK](/img/tutorials/acruxcore-walkthrough/06-trace-detail.png)
![AcruxCore's LLM span expanded, showing Model, Provider, Tokens, and Latency fields plus the full request Input and response Output JSON](/img/tutorials/acruxcore-walkthrough/07-trace-span-detail.png)

</details>

## Evaluation

Here LangSmith and Langfuse are the most mature, and we have real numbers to show for it,
not just descriptions of the UI.

- **LangSmith**: added examples to an existing dataset through a JSON-in/JSON-out dialog,
  then ran a real **Experiment** — 5 rows, a Correctness evaluator scoring **0.80**, and
  P50/P99 latency around 0.99s. LangSmith also has **Pairwise Experiments**, a dedicated
  UI for comparing two experiment runs against each other side by side.
- **Langfuse**: found an existing 5-item dataset, ran a real experiment end to end —
  completed in seconds at **$0.00021** total cost, 1.55s latency, with a real generated
  output for every row (e.g. a support-greeting prompt correctly personalized to each
  row's name and company).
- **PromptLayer**: no persistent "dataset you build up and reuse across experiments." What
  it has instead is two things: a **release-label A/B test** comparing live traffic between
  two named prompt versions, and an **Evaluate → Model comparison** tool that builds a real,
  ad-hoc spreadsheet calling multiple models on the same input row side by side (we ran this
  live: gpt-4o vs gpt-4o-mini, with cost/latency columns). It covers more eval ground than
  it first appears — just organized around one-off comparison grids rather than a
  save-once, run-many dataset object.
- **AcruxCore**: the one platform with no "hand-author an example" form at all. Datasets
  are built by **selecting real production feedback rows** (thumbs up/down on traces) — the
  eval set grows out of what real users actually flagged, not a separate fixture you
  maintain by hand. We tested this end to end: thumbs-upped a real trace, went to the
  Feedback page, selected that row, and clicked **Create dataset** — it built a real,
  named dataset with 1 example immediately, no synthetic fixture involved. The honest gap is
  volume, not mechanism: a brand-new account with only one or two traces will only ever be
  able to build a tiny dataset until real feedback accumulates, whereas LangSmith and
  Langfuse let you hand-author 5 examples in a couple of minutes regardless of production
  traffic. The underlying design — evaluate from real signal, not synthetic examples — is
  arguably the more useful long-term model once a team has real usage to draw on.

<details>
<summary>See the actual screens: evaluation on all four platforms</summary>

**LangSmith** — a real Experiment run: 5 rows scored by a Correctness evaluator:

![LangSmith experiment results grid showing 5 rows with Inputs, Reference Outputs, and generated Outputs columns](/img/tutorials/langsmith-walkthrough/ls-live-03-experiment-results.jpg)

**Langfuse** — a completed experiment run, real cost and latency for the whole dataset:

![Langfuse experiment run row showing completed status, item count, latency, and total cost](/img/tutorials/langfuse-walkthrough/lf-live-03-experiment-result.jpg)

**PromptLayer** — the Model comparison table, calling two real models side by side on one input row:

![PromptLayer model-comparison table showing gpt-4o and gpt-4o-mini outputs side by side](/img/tutorials/promptlayer-walkthrough/10-live-model-comparison-eval.jpg)

**AcruxCore** — selecting a real feedback row, then the resulting dataset it built:

![AcruxCore Feedback page with one real feedback row checked, showing 1 feedback row selected and a Create dataset button](/img/tutorials/acruxcore-walkthrough/08-feedback-selected.png)
![AcruxCore Evaluations page listing a real dataset named support-triage-regression with 1 example, created just now](/img/tutorials/acruxcore-walkthrough/09-dataset-created.png)

</details>

## From feedback to a fixed prompt

There's a question none of the sections above answer on its own: once a real trace has bad
(or good) feedback on it, how much manual work does it take to turn that into an actual
prompt change? We tested this directly on all four platforms — starting from a piece of
feedback, how many clicks to reach a saved prompt version?

**LangSmith** has the pieces but not the path. A trace has its own **Add feedback** control,
and **Add to Dataset** / **Add to Annotation Queue** buttons sit right next to it — but
there's no link from a trace into the Playground with that exact call pre-loaded. To act on
a piece of feedback, you'd copy the input/output out by hand and rebuild the call in the
Playground yourself, or go find the source Prompt separately.

**Langfuse** connects the whole thing. A generation inside a trace has **Add to datasets**,
**Annotate**, and a **Playground** button, in that order. Clicking Playground → *Fresh
playground* opens the real Playground with that exact system message and model already
filled in — edit it, then **Save as prompt** writes it back as a new prompt version. Trace →
Playground → Save, three real clicks.

**PromptLayer** has the identical shape under different names. A Request Log entry has
**Score N/A** (manual feedback), **Add to Table** (dataset), and **Open in Playground** —
which opens in a mode tied directly to the prompt that produced it. Edit the message, hit
**Save Template** (`Ctrl+S`), and it commits a new version of that same prompt.

**AcruxCore** has the same manual path — the LLM span on a trace carries its own **Open in
Playground →** link — but also has something none of the other three do: an automated
version of the entire loop. Select one or more feedback rows on the Feedback page and click
**Improve from feedback**. It builds a dataset from the selected rows, drafts several
candidate rewrites of the target prompt, runs the current production version *and* every
candidate against that dataset through an LLM judge, and returns a scored leaderboard — each
score linking back to its own trace and the judge's own trace. A **Promote to production**
button sits directly on the winning candidate.

We ran this for real: 1 feedback row in, 3 drafted candidates plus the production baseline
out, every one scored 100/HIGH by the judge (a single example doesn't stress-test the
candidates much, so treat the scores as illustrative, not a real "which one wins"
comparison) — but the mechanism itself is the point. It's the only one of the four platforms
where "here's a bad answer" can become "here's a better prompt, live" without leaving the
feedback page.

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

**AcruxCore** — feedback selected, then the automated Improve-from-feedback run:

![AcruxCore Feedback page with one feedback row selected and a Create dataset button](/img/tutorials/acruxcore-walkthrough/08-feedback-selected.png)
![AcruxCore Run report leaderboard showing 4 variants (3 drafted candidates plus production) scored 85.0-90.0 against gpt-4o-mini](/img/tutorials/comparison/acx-improve-leaderboard.png)
![AcruxCore candidate detail panel showing judge reasoning, a Passed verdict, and a Promote to production button](/img/tutorials/comparison/acx-improve-promote.png)

</details>

Every run above — whether triggered by hand or by Improve-from-feedback —
lands in AcruxCore's **Runs** tab, next to Datasets, with status, score, the
best-scoring variant, and duration for each one:

![AcruxCore Runs tab listing past evaluation runs with status, score, best variant, and duration columns](/img/tutorials/comparison/acx-runs-tab.png)

## Developer experience

All three competitors follow the same shape: **you call the model provider yourself, and
the platform's SDK wraps or observes that call.**

```python
# LangSmith
client = wrap_openai(OpenAI(api_key=...))

# Langfuse
from langfuse.openai import openai
client = openai.OpenAI(api_key=...)

# PromptLayer
pl_client = PromptLayer(api_key=...)
client = pl_client.openai.OpenAI(api_key=...)
```

Each of those took under 10 lines to get a real, traced (or logged) call working, once an
OpenAI key and a platform-specific API key existed. That setup step — bring your own
provider key, generate a platform key — was the single biggest source of friction across
this entire exercise: LangSmith's Playground, Langfuse's Playground and Experiments, and
PromptLayer's live runs were all fully blocked until we added one. None of the three ship a
trial model key or built-in provider access.

AcruxCore's SDK looks different because the gateway is in the path, not just watching —
and it ships as both a Node and a Python package, so we ran the same call both ways:

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

One call renders the stored prompt *and* routes it through the gateway — no separate
"wrap my OpenAI client" step, because there's no direct call to OpenAI in your code at all,
in either language. The demo account we used already had a provider key configured from
earlier work, so we didn't personally hit a BYOK wall on AcruxCore in this session — but to
be clear, AcruxCore's gateway is BYOK too; this account just happened to already be set up.

<details>
<summary>See the actual screens: the trace each platform's SDK script produced</summary>

**LangSmith** — `wrap_openai` + `@traceable`, no LangChain required:

![LangSmith trace detail for a script-generated call, showing a nested ChatOpenAI span, token count, and cost](/img/tutorials/langsmith-walkthrough/ls-sdk-01-trace-from-script.jpg)

**Langfuse** — the drop-in OpenAI wrapper, built on OpenTelemetry:

![Langfuse trace detail for a script-generated call, showing cost, latency, and OpenTelemetry SDK metadata](/img/tutorials/langfuse-walkthrough/lf-sdk-01-trace-from-script.jpg)

**PromptLayer** — `pl_client.openai` instead of importing `openai` directly:

![PromptLayer Requests table with the SDK-originated call at the top, showing model and real generated response](/img/tutorials/promptlayer-walkthrough/11-sdk-request-log.jpg)

**AcruxCore** — `hub.prompts.render` + `hub.gateway.chat`, one gateway hop, no OpenAI client at all:

![AcruxCore trace detail for a script-generated call, showing the expanded LLM span with Model, Provider, Tokens, Latency, and the real request/response JSON](/img/tutorials/comparison/acx-sdk-trace.png)

Both the Node and Python scripts' calls land on this same single-span trace page, just
with their own request ID and token count each run.

</details>

## Tools and tool-calling

All four platforms can *show* a tool call somewhere. Only one of them treats a tool as a
governed object the way it treats a prompt.

**LangSmith** has no separate tools section at all. When a traced chain includes a
LangChain tool node, the tool call shows up as its own child span inside the trace (we saw
this earlier: a `lookup_product_docs` span next to the `gpt-4o-mini` span in a real run) —
but that's a side effect of tracing, not a registry. There's nowhere to list, version, or
see aggregate call stats for a tool independent of the traces that happened to use it.

**Langfuse**'s Playground has a **Tools** control, but it's scoped to that one Playground
session: "Configure tools for your model to use," starting from "No tools attached," with a
**Create new tool** action that defines a JSON schema for that run. Nothing here persists as
a team-wide, reusable, versioned object — close the Playground tab and the tool definition
is gone unless you paste it in again next time.

**PromptLayer** tracks a **Tool Calls** count as a field on every Request Log entry (ours
read "0 Tool Calls"), and its Playground has a **Tools & Output** control for attaching a
function schema to a run — the same per-session shape as Langfuse, just under a different
name.

**AcruxCore** is the only one with a dedicated **Tools** section in the main navigation,
separate from Prompts. A tool (we had one real one, `get_weather`) gets its own page with
**Versions** and **Aliases** tabs — the identical versioning model prompts use — plus a
standalone **Tool analytics** page that aggregates real call volume, error rate, and P50/P95
latency per tool, sourced from traced tool executions. Tools are first-class, reusable,
governed objects here, not a byproduct of tracing or a one-off Playground schema.

<details>
<summary>See the actual screens: tools on all four platforms</summary>

**LangSmith** — a tool call only ever shows up as a span inside a trace:

![LangSmith trace view showing a lookup_product_docs tool-call span next to a gpt-4o-mini LLM span](/img/tutorials/langsmith-walkthrough/ls-07-trace-span-view.png)

**Langfuse** — a Playground-scoped tool definition, not a persistent catalog:

![Langfuse Playground's Tools panel showing "No tools attached" and a Create new tool button](/img/tutorials/comparison/lf-tools-attach.png)

**PromptLayer** — a Tools & Output control on the same per-request Playground shown earlier:

![PromptLayer Playground toolbar showing a Tools & Output button next to Save Template](/img/tutorials/comparison/pl-playground-save.png)

**AcruxCore** — a dedicated, versioned Tool Catalog with its own analytics page:

![AcruxCore Tools page listing the get_weather tool with a description and creation date](/img/tutorials/comparison/acx-tools-catalog.png)
![AcruxCore tool detail page showing Versions and Aliases tabs, identical to the prompt versioning model](/img/tutorials/comparison/acx-tools-versions.png)
![AcruxCore Tool analytics page showing call volume, error rate, and P50/P95 latency for get_weather](/img/tutorials/comparison/acx-tools-analytics.png)

</details>

## Pricing and free-tier limits

We didn't do a full plan-by-plan pricing audit as part of this hands-on pass — plan
details and quotas change often enough that we'd rather point you at each platform's
current pricing page than publish numbers that go stale. The one concrete thing we did
see directly: PromptLayer's workspace was on a **Team Trial** ("Trial ends in 7 days") with
visible usage quotas (100,000 request logs/month, 7,500 evaluation cells/month, 10,000
workflow node executions/month on that plan). We didn't verify equivalent numbers for
LangSmith or Langfuse hands-on, so we're deliberately not guessing at them here.

**AcruxCore** is the one platform here where pricing isn't a moving target: it's open
source and self-hostable, and free to use during the public beta — no trial clock, no
seat count, no usage quota to run into.

## What's unique to one platform

Pulled directly from each platform's own walkthrough — these are things only that one
platform does, not just a different button for the same idea.

**LangSmith**
- Git-like prompt commits with named Environments you promote a specific commit into.
- A dedicated **Studio** section for connecting LangGraph agents — no equivalent on any
  other platform here.
- **Pairwise Experiments** — comparing two experiment runs side by side, not just viewing
  each one's aggregate score in isolation.
- Rich per-span metadata (`ls_run_depth`, a `framework` tag) attached automatically, no
  extra configuration.

**Langfuse**
- Organization → project hierarchy as a first-class structure.
- Session and user badges live directly on the trace header, clickable to jump to every
  other trace in that session/user.
- One-click **"Add to datasets"** straight from a trace — turning real production
  behavior into eval data with no separate authoring step.

**PromptLayer**
- Release-label **A/B testing on live traffic**, instead of dataset-based offline
  experiments.
- Automatic `{{variable}}` detection while typing — no declaration step.
- A visible, colored line diff shown **before you even save** a new prompt version.
- A live, ad-hoc **model-comparison table** (the Evaluate button) that calls multiple
  models on one input row without requiring a saved dataset first.

**AcruxCore**
- **Stored-prompt gateway calls** — send a prompt name + alias, and the gateway renders
  and routes it in one request, with no client-side templating step at all.
- **Feedback-driven datasets** — eval data comes from real thumbs-up/down on production
  traces, not hand-authored fixtures.
- **Gateway-as-tracing-source** — every call is traced automatically because it physically
  routes through the gateway, not because an SDK wrapper is watching it.
- **Improve from feedback** — an automated loop that turns selected feedback rows into
  drafted prompt rewrites, runs the current production version and every candidate through
  an LLM judge, and lets you promote the winner in one click. None of the other three
  connect feedback to a rewrite-and-promote path this directly.
- **A first-class, versioned Tool Catalog** with its own analytics page (call volume, error
  rate, latency per tool) — the other three only expose tool calls as trace spans or
  per-session schema attachments, never as governed, reusable objects.
- **Gateway response caching** — cacheable calls can be served straight from the gateway,
  something none of the other three do since they aren't in the request path to begin with.
- **A second, full-parity SDK** — everything above is also available from Python
  (`pip install acruxcore`), not just the TypeScript client.

## Where AcruxCore stands

**Matches:** the alias/label-promotion model that LangSmith, Langfuse, and PromptLayer all
converge on is roughly where AcruxCore already is — immutable versions plus a movable
pointer, with a dedicated Diff tab covering the same ground as PromptLayer's inline diff.
Span-based tracing puts AcruxCore level with LangSmith and Langfuse, and ahead of
PromptLayer's flat-by-default request log.

**Ahead:** two findings from this pass are genuine structural advantages, not just UI
polish. First, the feedback → Playground → save loop that Langfuse and PromptLayer both
have (and LangSmith doesn't) is fully present in AcruxCore too — plus a materially more
automated version of it in **Improve from feedback**, which none of the three competitors
match. Second, the **Tool Catalog** treats tools as versioned, aliased, analytics-backed
objects, while all three competitors only ever show a tool call as a trace span or a
one-off Playground schema that doesn't persist.

**Behind:** the real gap is first-run speed, not the evaluation model itself. LangSmith and
Langfuse both let a fresh account go from zero to a scored experiment run in one session,
because they accept hand-authored, synthetic examples. AcruxCore deliberately doesn't —
its datasets are built only from real feedback on real production traces, so what you
evaluate against is what your users actually flagged, not a fixture someone guessed at. We'd
call that the more trustworthy long-term model, not a weaker one. The trade-off is
bootstrapping: a brand-new account has no feedback yet, so there's *nothing* to build a
first dataset from until real traffic and real thumbs-up/down accumulate — that early-days
gap is the thing worth fixing, not the "real feedback over synthetic examples" design choice
behind it. LangSmith's Pairwise Experiments (comparing two runs directly) and PromptLayer's
ad-hoc model-comparison grid (quick side-by-side without a saved dataset) are both things
AcruxCore doesn't have an equivalent for today, independent of where the dataset comes from.

**Worth adopting:**
- A lightweight, no-dataset-required comparison tool (PromptLayer's Model comparison) would
  remove the "nothing to evaluate yet" wall for brand-new AcruxCore accounts, without
  displacing the feedback-driven dataset model as the deeper, long-term path.
- A pairwise run-comparison view (LangSmith), once AcruxCore accounts typically have more
  than one experiment run to compare.
- Langfuse's session/user badges directly on the trace header are a small but genuinely
  nice affordance — AcruxCore supports session grouping, but we didn't verify a
  one-click badge-to-filter interaction as smooth as Langfuse's in this pass.

Nothing here suggests AcruxCore needs a different architecture — the gateway-as-tracing-source
model is a real structural advantage none of the three competitors have. The gap is entirely
in evaluation ergonomics for a brand-new account, which is a product feature to build, not a
redesign.

Want the deepest look at just the Langfuse side of this? We rebuilt one matched
example on both platforms and ran it step for step — see the

[full Langfuse vs AcruxCore comparison](/blog/acruxcore-vs-langfuse). We did the same
for the self-hosted Opik platform — see the
[full Opik vs AcruxCore comparison](/blog/acruxcore-vs-opik).
for the proxy-first alternative Helicone, including the real self-hosted bugs we hit
along the way — see the
[full Helicone vs AcruxCore comparison](/blog/acruxcore-vs-helicone).


Want to see it for yourself? The [Quickstart](/docs/getting-started/quickstart)
gets you from sign-up to a traced, gateway-routed call in about ten minutes.
