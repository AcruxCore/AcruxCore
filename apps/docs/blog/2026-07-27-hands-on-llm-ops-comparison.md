---
title: "8 LLM Observability Tools Tested Hands-On (2026)"
description: We hands-on tested 8 LLM observability tools — LangSmith, Langfuse, Opik, and more — comparing tracing, monitoring, and evals for AI agents in 2026.
slug: hands-on-llm-ops-comparison
authors: [acrux]
tags: [llmops-comparison, prompt-management, llm-tracing]
image: /img/social-card.png
keywords: [llm observability tools, ai observability, llm monitoring, ai agent observability, langsmith vs langfuse, langsmith vs promptlayer, phoenix vs opik, mlflow vs helicone, llm ops comparison, prompt management comparison, llm tracing comparison, llm evaluation comparison]
---

Most tool comparisons are written from docs and marketing pages. We didn't do that here.
We ran eight LLM-ops platforms ourselves — **LangSmith**, **Langfuse**, **PromptLayer**,
**Arize Phoenix**, **Opik**, **MLflow**, and **Helicone**, plus our own **AcruxCore** as the
baseline — and did the same thing on each one: create a prompt, version it, run it live
with a real model key, inspect the resulting trace, and try to build an eval. Then we wrote
a small script against each platform's own SDK and ran that too.

Tracing and monitoring — what most people mean by "LLM observability tools" — is only one
of nine angles below; prompt management, evals, guardrails, and tool-calling get the same
hands-on treatment.

<!-- truncate -->

:::tip[The 30-second version]
- **Matches** the field on prompt versioning (immutable versions + a movable pointer) and
  span-based tracing.
- **Ahead** on three things: an automated feedback→prompt loop (**Improve from feedback**),
  tools as versioned+measured objects (**Tool Catalog**), and being one of only two platforms
  genuinely **in** the request path (with MLflow).
- **Behind** on two things: no guardrails or spend controls (Opik, MLflow, and Helicone all
  have real ones), and no way to build a first eval dataset without real production feedback.
- Full reasoning: [Where AcruxCore stands](#where-acruxcore-stands).
:::

## Contents

- [At a glance](#at-a-glance) — the summary table, all eight platforms
- [Prompt management](#prompt-management)
- [Tracing and observability](#tracing-and-observability)
  - [Where the platform sits — in the request path, or beside it](#where-the-platform-sits--in-the-request-path-or-beside-it)
  - [Latency overhead across all eight](#latency-overhead-across-all-eight)
- [Evaluation](#evaluation)
- [Guardrails and spend controls](#guardrails-and-spend-controls)
- [From feedback to a fixed prompt](#from-feedback-to-a-fixed-prompt)
- [Developer experience](#developer-experience)
- [Tools and tool-calling](#tools-and-tool-calling)
- [Pricing and free-tier limits](#pricing-and-free-tier-limits)
- [What's unique to one platform](#whats-unique-to-one-platform)
- [Where AcruxCore stands](#where-acruxcore-stands) — the verdict

Each platform gets its own detailed, screenshot-backed post — that's where the evidence
lives. The first three got a full hands-on walkthrough of their own; the last four were run
as a matched, paired comparison directly against AcruxCore, using a second fixture prompt
(`vip-support-triage`) built specifically for that side-by-side format:

- [Hands-on with LangSmith](/blog/langsmith-hands-on-walkthrough)
- [Hands-on with Langfuse](/blog/langfuse-hands-on-walkthrough)
- [A hands-on walkthrough of PromptLayer](/blog/promptlayer-hands-on-walkthrough)
- [A hands-on walkthrough of AcruxCore](/blog/acruxcore-hands-on-walkthrough)
- [Phoenix vs AcruxCore](/blog/acruxcore-vs-phoenix)
- [Opik vs AcruxCore](/blog/acruxcore-vs-opik)
- [MLflow vs AcruxCore](/blog/acruxcore-vs-mlflow)
- [Helicone vs AcruxCore](/blog/acruxcore-vs-helicone)

This post is the synthesis: what's actually different, what's genuinely unique to one
platform, and an honest read on where AcruxCore stands next to the other seven.

:::note[Two fixtures, one honest seam]
LangSmith, Langfuse, and PromptLayer ran against AcruxCore in one pass on the original
`support-triage` prompt. Phoenix, Opik, MLflow, and Helicone came later, each compared
one-on-one against AcruxCore on a second fixture, `vip-support-triage`. The two groups were
never run against *each other* — treat any row spanning all eight as two passes stitched
together, not one race.
:::

## At a glance

The sections below go deep on each dimension with screenshots. If you just want the summary
— the first four columns are one interleaved run, the next four are each a separate
one-on-one pass against AcruxCore (see the note above), so read across a row as "how does
each platform compare to AcruxCore," not as one single eight-way race:

| Dimension | LangSmith | Langfuse | PromptLayer | Phoenix | Opik | MLflow | Helicone | AcruxCore |
|---|---|---|---|---|---|---|---|---|
| Prompt versioning | Git-like commits + Environments | Immutable versions + labels | Immutable versions + Release Labels + inline diff | Mustache sections (one construct for if *and* for) + real Diff view + tags | Flat `{{variable}}` only + real Diff view + Deploy-to labels | Full Jinja2 `{% if %}`/`{% for %}`, SDK-only creation + real diff + aliases | Flat `{{ hc:var:type }}` only; one version on this run, diff not reached | Immutable versions + Aliases + Diff tab |
| Tracing | Span-based (SDK-wrapped) | Span-based (SDK-wrapped) | Flat Request Log by default; Traces are separate and opt-in | Single rich span, OTel semantic conventions; Playground relays via GraphQL, not a real call | Span tree via `track_openai()`; confirmed the Playground alone produces no trace | Single span, automatic; prompt-version link needs a separate explicit SDK call | Not reached this run — manual-log endpoint 500'd on a missing self-host env var | Span-based (gateway auto-traces every call) |
| Where the platform sits | Beside the request path | Beside the request path | Beside the request path | Beside — Playground proxies via GraphQL, SDK calls go direct | Beside — ingests a trace after your own call | **In** the request path — a real AI Gateway | **In** the request path by design — but BYOK routing 501'd / hard-forwarded to the wrong host on this build | **In** the request path — every call routes through it |
| Guardrails / spend controls | None found | None found | None found | None found | Topic + PII guardrails, per project | Safety + PII + custom guardrails, and spend Budgets, per gateway endpoint | Rate Limit Rules (not content-inspecting); no PII/safety guardrail found | Spend caps and RPM/TPM limits enforced pre-call; no content guardrail |
| Evaluation | Datasets + Experiments, hand-authored examples | Datasets + Experiments, hand-authored examples | A/B test on live traffic + ad-hoc model-comparison grid | Dataset from a trace span + LLM/Code evaluator split; a templated-prompt experiment failed on a variable-shape mismatch | Dataset from any trace + inline creation; UI experiments defer to the SDK; plus dedicated Test suites | Built-in LLM-as-judge + custom code judges; hit a real dataset-list-page bug | Datasets curated from Request rows; none existed since no call was ever logged this run | Feedback-driven datasets, no hand-authored examples; plus rule-based online evaluation — a judge scoring every matching live trace |
| Feedback → Playground → save loop | Feedback + Dataset + Annotation Queue exist, but no trace → Playground jump | Full loop: trace → Playground (pre-loaded) → Save as prompt | Full loop: Request → Playground (pre-loaded) → Save Template | Not run as this exact loop — see [Phoenix vs AcruxCore](/blog/acruxcore-vs-phoenix) | Not run as this exact loop — see [Opik vs AcruxCore](/blog/acruxcore-vs-opik) | Not run as this exact loop — see [MLflow vs AcruxCore](/blog/acruxcore-vs-mlflow) | Not run as this exact loop — see [Helicone vs AcruxCore](/blog/acruxcore-vs-helicone) | Full loop, plus an automated version: feedback → drafted candidates → judged run → Promote to production |
| Tool calling | Shows up as spans only; no catalog | Playground-scoped tool schema; no catalog | Per-request tool-call count; no catalog | Ad-hoc JSON Schema per Playground prompt; nothing executes or gets measured | No tool-catalog concept at all; its "Agent playground" needs a live process wired in by code | MCP Registry — catalogs external MCP *servers* by manifest, doesn't execute an individual tool | No tool-catalog concept found in any nav section checked | Dedicated versioned Tool Catalog + a Tool analytics page |
| Developer experience | `wrap_openai` + `@traceable` around your own OpenAI call | Drop-in OpenAI wrapper, built on OpenTelemetry | `pl_client.openai` wrapper around your own OpenAI call | `register()` + `OpenAIInstrumentor()`; no server-side render call, so template logic gets hand-duplicated in Python | `track_openai()` wraps a client you already own; trace appears once it's called | `load_prompt()` + `start_span()` + a separate `link_prompt_versions_to_trace()` call | No stored-prompt SDK call; a direct provider call plus a manual log() call that 500'd this run | `hub.prompts.render` + `hub.gateway.chat` — no direct call to a provider at all, Node and Python |
| Measured overhead | Not benchmarked in this series | Real, sub-baseline in the six-platform run | Not benchmarked in this series | -68ms, CI crosses zero | +102ms, CI does not cross zero (real) | -44ms, CI crosses zero | 0/100 rounds completed — every gateway call failed on this self-hosted build | Ranges -63ms to +206ms across runs — see [Latency overhead](#latency-overhead-across-all-eight) below |
| Pricing (what we actually saw) | Not verified hands-on | Not verified hands-on | Team Trial plan with visible quotas | See [compare page](https://acruxcore.com/compare) | See [compare page](https://acruxcore.com/compare) | See [compare page](https://acruxcore.com/compare) | See [compare page](https://acruxcore.com/compare) | Open source, free during public beta — no trial, no quota |

License, team structure, security, and community stats for Phoenix, Opik, MLflow, and
Helicone live on the [compare page](https://acruxcore.com/compare) rather than repeated here —
they're tables there too, so a price or license change is one edit instead of five.

## Prompt management

:::info[Quick take]
MLflow ties AcruxCore on real conditional templating; every other platform flattens
`if`/`for` logic into plain text before saving.
:::

All eight tools landed on the same underlying idea — **immutable versions plus a movable
pointer** — just with wildly different amounts of real templating logic and ceremony
around it.

| Platform | Conditional templating | Live/staging mechanism | Diff on save |
|---|---|---|---|
| LangSmith | Flat `{{variable}}` | Named **Environments** (Production/Staging) | Not shown inline |
| Langfuse | `{{variable}}` + Jinja-style `{% if %}` in a real production prompt | **Labels** (`production`/`latest`) | Not shown inline |
| PromptLayer | Flat `{{variable}}`, auto-detected while typing | **Release Labels** attached to a version | Yes — colored line diff in the save dialog |
| Phoenix | Mustache — `{{#section}}` doubles as both if *and* for | `production`/`staging` **tags** | Yes — real version-diff toggle |
| Opik | Flat `{{variable}}` only, verified hands-on — no `{% if %}`/`{% for %}` | "Deploy to" **tags** a version | Yes — real Diff panel |
| MLflow | Full **Jinja2** — `{% if %}`/`{% for %}` both real, registered verbatim, no flattening needed | `@production`/`@staging` **SDK aliases** | Yes — real word-level diff |
| Helicone | Flat `{{ hc:var:type }}` only | `production` auto-applied to v1 | Not reached — only one version ever existed on this run |
| AcruxCore | Real **nunjucks** `{% if %}`/`{% for %}`, rendered server-side | **Aliases** (`production`/`staging`) | Yes — dedicated Diff tab on the prompt page |

Ranked by how much real conditional logic survives:

1. **MLflow** — strongest of any competitor. The only one where the fixture's actual
   `{% if is_vip %}` branch and `{% for ticket in tickets %}` loop didn't need flattening,
   matching AcruxCore's own nunjucks logic feature for feature.
2. **Langfuse and AcruxCore** — real production conditionals (Jinja-style / nunjucks), one
   rung below MLflow.
3. **Phoenix** — a real but different construct: Mustache sections do double duty as both
   `if` and `for`.
4. **Opik, Helicone, LangSmith, PromptLayer** — flat substitution only. The VIP branch and
   the ticket list had to be flattened into plain text before saving.

On promotion: we actually clicked "promote" and watched the label move on AcruxCore
(`production` v1 → v2), PromptLayer (Release Label), Phoenix and Opik (their own tag/deploy
controls), and MLflow (`@production`/`@staging` via SDK call). LangSmith's Environments
feature exists but had nothing deployed on our test account, so we saw the UI, not a live
promotion. Helicone never got this far on this run — the Playground's live-call step failed
before a second version could even be created (see **Tracing and observability** below).

<details>
<summary>See the actual screens: prompt versioning on all eight platforms</summary>

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

**Opik** — flat `{{variable}}` substitution, a real Diff panel, and a "Deploy to" environment label:

![Opik's New chat prompt dialog for the recreated vip-support-triage prompt, showing flat {{company}} and {{customer_message}} variable substitution with no conditional syntax available](/img/comparison/opik/op-01-prompt-editor.png)
![Opik's Compare v1 to v2 panel, showing the old system message in red strikethrough on the left and the new message in green on the right, side by side](/img/comparison/opik/op-03-diff-tab.png)

**MLflow** — the only competitor with real Jinja2 conditionals and loops, registered verbatim:

![MLflow's prompt detail page for vip-support-triage version 3, showing @production and @staging aliases, a commit message, and the full Jinja2 system template with if/else and for-loop syntax rendered as literal text](/img/comparison/mlflow/mf-01-prompt-version-3.png)
![MLflow's word-level diff between version 3 and version 2, with "4" highlighted red and "5" highlighted green on the sentence-count line](/img/comparison/mlflow/mf-02-diff-view.png)

**Helicone** — flat `{{ hc:var:type }}` substitution, and the single version this run ever produced:

![Helicone's Playground with the recreated vip-support-triage system message, showing the flat {{ hc:company:string }} variable syntax and the Save Prompt dialog with our commit message about flattening the nunjucks logic](/img/comparison/helicone/hl-01-prompt-editor.png)

**AcruxCore** — the prompt editor, the Versions tab after promoting `production` to v2, and the Diff tab:

![AcruxCore prompt editor showing version tabs including Editor, Preview, Versions, Diff, Audit](/img/tutorials/acruxcore-walkthrough/02-prompt-editor.png)
![AcruxCore Versions tab listing v2 tagged PRODUCTION and v1 tagged STAGING, each with a promote link and a View traces link](/img/tutorials/acruxcore-walkthrough/03-alias-promoted.png)
![AcruxCore's Diff tab showing a line-level, colored diff between prompt version 1 and version 2](/img/tutorials/acruxcore-walkthrough/04-diff-tab.png)

</details>

## Tracing and observability

:::info[Quick take]
5 platforms trace by default, 3 don't — and on 2 of those 5, clicking the Playground
doesn't produce a trace at all.
:::

This is where the eight LLM observability tools split into two real camps, not just
cosmetic differences.

**Span-based, multi-step tracing is the default** on LangSmith, Langfuse, Phoenix, MLflow,
and AcruxCore — each shows a tree or a rich single span, not just a flat call record:

- **LangSmith** — a real trace showed a parent run containing a tool-call span and a
  separate LLM-call span.
- **Langfuse** — a trace groups a `chat-completion` generation under a top-level trace, with
  session and user badges right on the header.
- **Phoenix** — its single span is genuinely richer than AcruxCore's own view:
  Info/Attributes/Events tabs and OTel semantic-convention attributes, credit due even on
  our own fixture.
- **MLflow** — every Gateway call traces automatically, but linking it back to the prompt
  version that produced it needs a separate, easy-to-forget `link_prompt_versions_to_trace()`
  call. AcruxCore attaches that link at render time, with nothing extra to call.
- **AcruxCore** — every gateway call is auto-traced as a span the moment it's routed
  through, with the SDK's `trace()` available to wrap additional steps into the same tree.

**PromptLayer, Opik, and Helicone are the outliers, each for a different reason:**

- **PromptLayer** — default is a flat per-call **Request Log** (model, latency, cost,
  tokens, no nested steps). True multi-step **Traces** are a separate, opt-in feature that
  stayed empty even after several live model calls; it needs explicit SDK-level
  `trace_id`/span instrumentation, which we didn't set up.
- **Opik** — its Logs tab stayed at "No traces yet" after a Playground run. A real trace
  only appeared once we called the SDK-wrapped client instead.
- **Helicone** — never produced a trace at all on this run. Its Playground's `Run` button
  401'd with an empty auth token, and the fallback manual-logging call 500'd on a missing
  `S3_REGION` environment variable in the self-hosted `docker-compose` — a real,
  reproducible bug, not a design choice.

**A related surprise: running the Playground does not create a trace at all on either
Langfuse or Opik.** We confirmed zero new rows in each platform's tracing view immediately
after a successful Playground run — only real SDK/API-instrumented calls show up there. If
you're evaluating either by clicking around its Playground, you can easily conclude tracing
"isn't working" when it's actually just not wired to that particular button.

**Why AcruxCore needs no tracing setup step:** the gateway sits **in** the request path —
your call physically routes through AcruxCore's servers, so it's traced by construction, the
same reason MLflow's Gateway calls trace automatically too. LangSmith, Langfuse, Phoenix, and
Opik instead trace by having their SDK wrap or observe a call you still make directly to the
provider. Neither approach is strictly "better": the gateway model gives you tracing (and
cost/routing control) for free the moment you switch endpoints; the SDK-wrapper model works
with any call path you already have, gateway or not. More on this split, and where Helicone
fits into it, right below.

<details>
<summary>See the actual screens: trace views on all eight platforms (Helicone never produced one)</summary>

**LangSmith** — a real span tree from a live run: parent chain, prompt-template spans, and the model call, with real latency and token count:

![LangSmith trace detail showing a RunnableSequence span tree feeding into a gpt-5.6-terra span, with latency and token count](/img/tutorials/langsmith-walkthrough/ls-live-02-trace-span-tree.png)

**Langfuse** — session and user badges live on the trace header, with cost/token breakdown inline:

![Langfuse trace detail panel showing session grouping, cost, token counts, and tags](/img/tutorials/langfuse-walkthrough/lf-03-trace-detail.jpg)

**PromptLayer** — the flat Request Log (what you get by default) versus Traces, which stayed empty even after a live model call:

![PromptLayer Request Log detail page for a live request, showing model, cost, and token counts](/img/tutorials/promptlayer-walkthrough/08-live-request-log-detail.jpg)
![PromptLayer Traces and Analytics page showing No traces found even after a live model call](/img/tutorials/promptlayer-walkthrough/09-live-traces-still-empty.jpg)

**Phoenix** — a single span, richer attribute/event tabs than AcruxCore's own view:

![Phoenix's trace detail: ChatCompletion span showing status, total cost, latency, and the full input/output messages](/img/comparison/phoenix/px-05-trace-detail.png)

**Opik** — a two-level span tree, but only after the SDK-wrapped client was called, not from the Playground:

![Opik's trace detail: a two-node span tree (outer trace + inner LLM span), 2.6s latency, <$0.01 cost, 138 total tokens, full system/user/assistant messages shown](/img/comparison/opik/op-06-trace-detail.png)

**MLflow** — automatic on every Gateway call, with prompt-version lineage requiring a separate explicit call:

![MLflow's trace detail Linked prompts tab, showing a table with one row: prompt name vip-support-triage, version 3](/img/comparison/mlflow/mf-04-trace-linked-prompt.png)

**Helicone** — the Requests page never populated on this run, because the logging call it depends on failed:

![Helicone's Requests page still showing only its static "Integrate to see your requests" preview data — our real OpenRouter calls never appear because the log call failed](/img/comparison/helicone/hl-06-datasets-empty.png)

**AcruxCore** — a gateway call auto-traced as a span, with model/provider fields visible on the span itself:

![AcruxCore trace detail page showing 1 span, token count, and status OK](/img/tutorials/acruxcore-walkthrough/06-trace-detail.png)
![AcruxCore's LLM span expanded, showing Model, Provider, Tokens, and Latency fields plus the full request Input and response Output JSON](/img/tutorials/acruxcore-walkthrough/07-trace-span-detail.png)

</details>

| Feature | Trace shape | Produced by the Playground? | Prompt-version link |
|---|---|---|---|
| LangSmith | Span tree (parent run + child spans) | Yes | Not tracked as a distinct step |
| Langfuse | Trace groups a generation, session/user badges | **No** — confirmed | Not applicable |
| PromptLayer | Flat Request Log by default; Traces opt-in and stayed empty | Only unlocks running, not tracing | Not applicable |
| Phoenix | Single span, rich attribute/event tabs | Playground doesn't call the provider directly (GraphQL relay) | Not surfaced in this run |
| Opik | Span tree (outer trace + inner LLM span) | **No** — confirmed, only the SDK path traces | Not applicable |
| MLflow | Single span per Gateway call | Yes, automatically | Requires a separate `link_prompt_versions_to_trace()` call |
| Helicone | Not reached — logging call 500'd | No — Playground `Run` 401'd | Not reached |
| AcruxCore | Single span per gateway call | Yes, automatically | Automatic — attached at render time |

The obvious follow-up question is whether sitting in the request path costs you latency —
covered next, and measured across all eight further down.

### Where the platform sits — in the request path, or beside it

The gateway-versus-SDK split above is really about one underlying design choice most LLM
observability platforms have to make: does the platform sit **in** the request path,
physically routing your call, or **beside** it, watching a call you still make yourself?
LangSmith, Langfuse, PromptLayer, Phoenix, and Opik
are all "beside" — your client calls the provider directly, and each platform's SDK observes
or a manual log call reports it after the fact. MLflow and AcruxCore are both genuinely "in
the path": you call a named gateway endpoint, and it's the one that calls the provider. That
structural similarity makes MLflow the closest match to AcruxCore's own architecture of
any competitor in this whole series.

Helicone is designed to be "in the path" too — its Providers, Cache, and Rate Limits pages
are real, documented request-path features — but hands-on, routing our non-native
(OpenRouter) key through it failed two different ways: one route hard-forwarded the
`Authorization` header to `api.openai.com` regardless of which provider we'd registered, and
the generic multi-provider route returned a flat `501 Not implemented`, confirmed by reading
the self-hosted service's own compiled source. That's a real bug on this build, not evidence
against the design itself.

Being "in the path" isn't automatically better — it's a different trade. It buys routing,
caching, and budget enforcement before the provider is ever called, at the cost of one more
hop and one more thing that has to work; sitting "beside" the path costs nothing extra but
means tracing depends on remembering to instrument every call site.

| Feature | Phoenix | Opik | MLflow | Helicone |
|---|---|---|---|---|
| Where it sits | Beside — Playground proxies via GraphQL, SDK calls go direct | Beside — ingests a trace after your own call | **In** the path — a named Gateway endpoint | **In** the path by design — but BYOK routing failed on this build |
| BYOK, caching, budgets | Not applicable | Not applicable | Real Gateway usage tracking, guardrails, and Budgets per endpoint | Documented cache/rate-limit headers, but the routing itself 501'd/misrouted |

### Latency overhead across all eight

AcruxCore's own dedicated [gateway-overhead post](/blog/llm-gateway-overhead) measured its
software cost against a direct OpenAI call in isolation, once: about **42 ms**, with the
rest of what you'd see in production being ordinary network distance you control by
deploying close to your callers. The comparisons below repeat that measurement four more
times, each paired against a different competitor, which is what makes the swing across
runs visible rather than hidden behind one number.

Every comparison in this series times the identical call three ways, interleaved over 100
rounds, against a real baseline:

- `phoenix_otel` — -68ms (crosses zero, not real)
- `opik_tracked_sdk` — +102ms (the only one of the four whose CI doesn't cross zero — a
  real, if small, cost)
- `mlflow_gateway` — -44ms (crosses zero, not real)
- `helicone_gateway` — failed all 100 rounds outright (an auth bug, not a latency number)
- AcruxCore's own gateway overhead ranged from **-63ms to +72ms** across these same paired
  runs — every one of those intervals also crosses zero

At this sample size, neither AcruxCore's nor most competitors' overhead is statistically
distinguishable from a raw call to the provider.

| Path | Median gap vs. baseline | 95% CI | Distinguishable from zero? |
|---|---|---|---|
| Phoenix OTel SDK | -68ms | [-166, 102]ms | No |
| Opik tracked SDK | +102ms | [+14, +191]ms | **Yes — real** |
| MLflow AI Gateway | -44ms | [-98, +85]ms | No |
| Helicone AI Gateway | — | — | 0/100 rounds completed |
| AcruxCore gateway (vs. Phoenix's run) | +72ms | [-31, +201]ms | No |
| AcruxCore gateway (vs. Opik's run) | +206ms | [+123, +293]ms | **Yes — real** |
| AcruxCore gateway (vs. MLflow's run) | -63ms | [-120, +70]ms | No |
| AcruxCore gateway (vs. Helicone's run) | -4ms | [-136, +124]ms | No |

AcruxCore's own number swinging from -63ms to +206ms across four separate 100-round runs is
the same lesson as our dedicated [gateway-overhead post](/blog/llm-gateway-overhead): a
single run's overhead is noisy, and the honest number is a range with a confidence interval,
not one point estimate. The [full-cycle, six-platform benchmark](/blog/full-cycle-latency-benchmark)
— real OpenAI billing, four independent 100-round runs — is the most rigorous version of
this measurement we've published, and it includes Opik, MLflow, Langfuse, Helicone, and
Phoenix all in one interleaved run against AcruxCore's gateway and gateway-free BYOK modes.

## Evaluation

:::info[Quick take]
LangSmith, Langfuse, Phoenix, and Opik all let a fresh account build a dataset in minutes
(hand-authored or one-click from a trace). AcruxCore builds datasets from real feedback
only — deeper signal, but nothing to work with on day one.
:::

LangSmith, Langfuse, Phoenix, and Opik are the most mature here, and we have real numbers
and real bugs to show for it, not just descriptions of the UI.

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
- **Phoenix**: builds a dataset from a trace as smoothly as AcruxCore does — select a span,
  "Add to Dataset," done — and its Evaluators page draws a real distinction AcruxCore
  doesn't surface as its own category: **LLM evaluators** (AI-judged) versus **Code
  evaluators** (deterministic checks like `exact_match` and regex). Pointing a real
  experiment at that dataset broke, though: it stores the trace's *rendered* messages, not
  the original template variables, so running the templated prompt against it failed with
  "Dataset is missing input for variables."
- **Opik** is the deepest platform here on this dimension, not just for its dataset flow
  (also from any trace, with inline "create new dataset" in the same dialog): alongside
  that, it has dedicated **Test suites** (import cases from a CSV/JSON or the SDK, framed
  explicitly as pre-deployment regression testing) and **Online evaluation** — rules that
  score live production traffic automatically. AcruxCore has its own rule-based version of
  the latter (see the AcruxCore entry below); Test suites remain something no other
  platform in this whole post has.
- **MLflow** ships built-in **LLM-as-judge** and custom code judges from a clean empty
  state, plus dataset creation from the UI or "Add to dataset" from any trace. We hit one
  real bug of our own here: after naming and creating a dataset, its list page kept showing
  the empty state — the dataset existed the whole time, confirmed via the SDK, the list view
  just never picked it up.
- **Helicone**'s dataset path never got evidence on this run: its Datasets page curates rows
  from the Requests table, and since no call of ours ever successfully logged (see
  **Tracing and observability** above), there was nothing to curate.
- **AcruxCore**: the one platform with no "hand-author an example" form at all. Datasets
  are built by **selecting real production feedback rows** (thumbs up/down on traces) — the
  eval set grows out of what real users actually flagged, not a separate fixture you
  maintain by hand. We tested this end to end: thumbs-upped a real trace, went to the
  Feedback page, selected that row, and clicked **Create dataset** — it built a real,
  named dataset with 1 example immediately, no synthetic fixture involved. The honest gap is
  volume, not mechanism: a brand-new account with only one or two traces will only ever be
  able to build a tiny dataset until real feedback accumulates, whereas LangSmith, Langfuse,
  Phoenix, and Opik all let you build a dataset in a couple of minutes regardless of
  production traffic. The underlying design — evaluate from real signal, not synthetic
  examples — is arguably the more useful long-term model once a team has real usage to draw
  on. Separately, AcruxCore also has rule-based **online evaluation**: a rule with a judge
  (built-in or a custom prompt) scores every matching live trace as it lands, the same idea
  as Opik's Online evaluation above.

<details>
<summary>See the actual screens: evaluation on all eight platforms (Helicone had nothing to show)</summary>

**LangSmith** — a real Experiment run: 5 rows scored by a Correctness evaluator:

![LangSmith experiment results grid showing 5 rows with Inputs, Reference Outputs, and generated Outputs columns](/img/tutorials/langsmith-walkthrough/ls-live-03-experiment-results.jpg)

**Langfuse** — a completed experiment run, real cost and latency for the whole dataset:

![Langfuse experiment run row showing completed status, item count, latency, and total cost](/img/tutorials/langfuse-walkthrough/lf-live-03-experiment-result.jpg)

**PromptLayer** — the Model comparison table, calling two real models side by side on one input row:

![PromptLayer model-comparison table showing gpt-4o and gpt-4o-mini outputs side by side](/img/tutorials/promptlayer-walkthrough/10-live-model-comparison-eval.jpg)

**Phoenix** — the LLM/Code evaluator split, and the experiment that failed on a variable-shape mismatch:

![Phoenix's Evaluators overview diagram: Dataset → Task (Playground Prompt) → Evaluator (LLM or Code) → Score](/img/comparison/phoenix/px-12-evaluators-overview.png)
![Phoenix's experiment view over the new dataset — the saved prompt selected, but "Dataset is missing input for variables: company, is_vip, tickets, question" because the dataset stored rendered messages, not template variables](/img/comparison/phoenix/px-11-experiment-run.png)

**Opik** — a dataset-bound experiment run, plus the Test suites page no other platform here has an equivalent of, and the Online evaluation page that AcruxCore also has a rule-based version of:

![Opik's Playground with the dataset loaded, a variant bound to the dataset's message field, and a real experiment result row showing the model's reply next to the dataset's expected output and feedback score](/img/comparison/opik/op-08-experiment-run.png)
![Opik's empty Test suites page, offering Upload a file (CSV/JSON) or Use SDK as the two ways to define test cases with expected outputs and scoring](/img/comparison/opik/op-11-test-suites.png)
![Opik's "No online evaluations yet" empty state under Online evaluation, with "Create a rule to automatically score your model's outputs" and a Create your first rule button](/img/comparison/opik/op-13-online-evaluation.png)

**MLflow** — built-in judges, and the dataset the list page failed to show:

![MLflow's empty Judges page: "Add a judge to your experiment to measure your GenAI app quality," with New LLM judge and New custom code judge buttons](/img/comparison/mlflow/mf-07-judges.png)
![MLflow's vip-support-triage-eval dataset detail page with 2 records, each an Inputs/Expectations pair, tagged with the creating user](/img/comparison/mlflow/mf-06-eval-dataset.png)

**AcruxCore** — selecting a real feedback row, then the resulting dataset it built:

![AcruxCore Feedback page with one real feedback row checked, showing 1 feedback row selected and a Create dataset button](/img/tutorials/acruxcore-walkthrough/08-feedback-selected.png)
![AcruxCore Evaluations page listing a real dataset named support-triage-regression with 1 example, created just now](/img/tutorials/acruxcore-walkthrough/09-dataset-created.png)

</details>

## Guardrails and spend controls

:::info[Quick take]
Opik and MLflow each have a real content guardrail; Helicone has a rate-limit rule builder.
AcruxCore enforces spend caps and rate limits on its gateway, but has no content guardrail.
:::

Two different dimensions sit behind this heading. Nothing on LangSmith, Langfuse,
PromptLayer, Phoenix, or AcruxCore inspects a call's input or output for restricted
content. Enforcing a spending cap is a separate question, and one only a platform in the
request path can answer at all — MLflow and AcruxCore both do; the observability-first
platforms have no call to stop.

**Opik** has a "Set a guardrail" panel, configurable per project: a **Topic guardrail**
(a sensitivity slider plus a restricted-topics list) and a **PII guardrail** that flags
specific categories — credit card numbers, phone numbers, emails, and more — each with its
own threshold, plus a ready-to-run Python snippet using `opik.guardrails`.

**MLflow** goes further: every Gateway endpoint has its own Guardrails tab offering a
**Safety** guardrail ("detects harmful, offensive, or toxic content"), a **PII Detection**
guardrail, or a fully custom guardrail with your own instructions — and a separate
**Budgets** page where a policy sets a reset period, an action for when it's exceeded, and a
spending window, tracked against real current spend.

**Helicone** doesn't have a content-inspecting guardrail, but its Monitor → Rate Limits page
has a real **Rate Limit Rules** builder, distinct from the BYOK routing bugs we hit
elsewhere on this build — a genuine, working configuration surface even where other parts
of this run weren't.

<details>
<summary>See the actual screens: guardrails, budgets, and rate limits</summary>

![Opik's "Set a guardrail" panel: Topic guardrail and PII guardrail toggles with sensitivity sliders, a restricted personal data checklist (credit card number, phone number checked), and a Python code sample using opik.guardrails](/img/comparison/opik/op-12-guardrails.png)
![MLflow's "Create Guardrail" dialog, showing three options: Safety (detects harmful, offensive, or toxic content), PII Detection (detects names, emails, and phone numbers), and Custom Guardrail](/img/comparison/mlflow/mf-09-guardrail-types.png)
![MLflow's empty Budgets page: "No budget policies created. Set spending limits and control costs across your endpoints," with a Create budget policy button and columns for Reset period, On Exceeded, Window Start/End, and Current Spend](/img/comparison/mlflow/mf-11-budgets.png)
![Helicone's Rate Limit Rules tab: "No rate limits defined yet. Create your first rate limit rule to get started," with a Create Rule button](/img/comparison/helicone/hl-14-rate-limit-rules.png)

</details>

| Feature | Opik | MLflow | Helicone | AcruxCore |
|---|---|---|---|---|
| Content guardrails | Topic + PII, per project | Safety + PII + custom, per Gateway endpoint | Not found | None |
| Spend enforcement | Not found | Real Budgets: reset period, on-exceeded action, spend tracking | Not found (cost is visible, not capped) | Cap per team or virtual key, `402` before the provider call |
| Rate limiting | Not found | Not found | Real Rate Limit Rules, segmented per end user | Per-virtual-key RPM/TPM, `429` before the provider call |

Content guardrails are the row with no AcruxCore answer today — a real gap next to Opik and
MLflow, not a rebuttal to the request-path or tool-catalog advantages the rest of this post
covers. On rate limiting the difference is narrower than the row suggests: Helicone can
scope a rule to an individual end user, where an AcruxCore limit stops at the virtual key.

## From feedback to a fixed prompt

:::info[Quick take]
Langfuse and PromptLayer connect feedback → Playground → save in 3 clicks. AcruxCore is the
only one of the four with an automated version of that whole loop.
:::

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

Every run above — whether triggered by hand or by Improve-from-feedback — lands in
AcruxCore's **Runs** tab, next to Datasets, with status, score, the best-scoring variant,
and duration for each one:

![AcruxCore Runs tab listing past evaluation runs with status, score, best variant, and duration columns](/img/tutorials/comparison/acx-runs-tab.png)

</details>

This exact trace → Playground → save loop wasn't re-run on Phoenix, Opik, MLflow, or
Helicone — their comparisons instead tested dataset-from-trace (see **Evaluation** above),
which is the closest equivalent step each of those posts actually drove hands-on. Nothing in
their own dashboards or docs suggested a feedback-triggered rewrite loop like AcruxCore's
Improve from feedback exists on any of the four; if a reader knows otherwise for a specific
platform, that's worth us checking directly rather than assuming from this pass.

## Developer experience

:::info[Quick take]
5 of 7 competitors wrap a provider call you still make yourself. MLflow is a gateway your
call always routes through. AcruxCore is a gateway too, but optional — a gateway-free BYOK
mode lets your code call the provider directly when you want that.
:::

Five of the seven competitors follow the same basic shape: **you call the model provider
yourself, and the platform's SDK wraps or observes that call.**

```python
# LangSmith
client = wrap_openai(OpenAI(api_key=...))

# Langfuse
from langfuse.openai import openai
client = openai.OpenAI(api_key=...)

# PromptLayer
pl_client = PromptLayer(api_key=...)
client = pl_client.openai.OpenAI(api_key=...)

# Opik — the same "wrap a client you already own" shape
client = track_openai(OpenAI(api_key=OPENROUTER_KEY, base_url="https://openrouter.ai/api/v1"))

# Phoenix goes a step further in the same direction — instrument once, no per-call wrapping —
# but has no server-side prompt-render endpoint, so its Mustache logic had to be
# hand-duplicated in Python for the script to render it correctly:
from phoenix.otel import register
from openinference.instrumentation.openai import OpenAIInstrumentor
OpenAIInstrumentor().instrument(tracer_provider=register(endpoint="http://localhost:6006/v1/traces"))
```

- Each of the first three took under 10 lines to get a real, traced (or logged) call
  working, once an OpenAI key and a platform-specific API key existed.
- That setup step — bring your own provider key, generate a platform key — was the single
  biggest source of friction across this entire exercise: LangSmith's Playground,
  Langfuse's Playground and Experiments, and PromptLayer's live runs were all fully blocked
  until we added one.
- None of the three ship a trial model key or built-in provider access.

**MLflow and Helicone break the wrap-a-client pattern in opposite directions.** MLflow needs
the most calls of any platform in this whole series to do what AcruxCore's two calls do —
`load_prompt()`, then `start_span()` around the Gateway call, then a separate,
easy-to-forget `link_prompt_versions_to_trace()` afterward:

```python
# MLflow — three separate calls to render, trace, and link lineage
prompt = mlflow.genai.load_prompt("prompts:/vip-support-triage@production")
with mlflow.start_span(name="vip-support-triage-gateway-call") as span:
    resp = requests.post(f"{TRACKING_URI}/gateway/mlflow/v1/chat/completions", json={...})
mlflow.MlflowClient().link_prompt_versions_to_trace(trace_id=span.trace_id, prompt_versions=[prompt])
```

Helicone has no stored-prompt SDK surface at all: the script calls the provider directly
with `requests`, then attempts Helicone's manual-log endpoint — the exact call that 500'd in
**Tracing and observability** above, every time we ran it:

```python
# Helicone — call the provider directly, then a manual log call (which 500'd this run)
res = requests.post("https://openrouter.ai/api/v1/chat/completions", ..., json=body)
log_res = requests.post(f"{HELICONE_BASE_URL}/v1/trace/custom/log", ..., json=log_body)
```

AcruxCore's SDK looks different from all seven because the gateway is in the path, not just
watching — and it ships as both a Node and a Python package, so we ran the same call both
ways:

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
"wrap my OpenAI client" step, no server-side render-then-link-then-trace sequence, because
there's no direct call to the provider in your code at all, in either language. The demo
account we used already had a provider key configured from earlier work, so we didn't
personally hit a BYOK wall on AcruxCore in this session — but to be clear, AcruxCore's
gateway is BYOK too; this account just happened to already be set up.

Every script from this section, plus the four latency benchmarks they feed, is committed and
runnable — see the full source for
[Phoenix](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/phoenix-vs-acruxcore/python/px_trace_run.py),
[Opik](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/opik-vs-acruxcore/python/op_trace_run.py),
[MLflow](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/mlflow-vs-acruxcore/python/mlflow_gateway_run.py), and
[Helicone](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/helicone-vs-acruxcore/python/hl_trace_run.py).

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

**Opik** — the same two-level span tree as the earlier Playground fixture, produced by the wrapped client:

![Opik's trace for the script-generated call: 138 total tokens, <$0.01 cost, 2.6s latency, model and provider metadata visible on the span](/img/comparison/opik/op-06-trace-detail.png)

**MLflow** — automatic on the Gateway call, prompt lineage attached by the extra explicit call:

![MLflow's trace detail Linked prompts tab, showing a table with one row: prompt name vip-support-triage, version 3](/img/comparison/mlflow/mf-04-trace-linked-prompt.png)

**Helicone** — no trace to show; the manual-log call reproduced the same 500 every time:

![Helicone's Requests page still showing only its static "Integrate to see your requests" preview data — our real OpenRouter calls never appear because the log call failed](/img/comparison/helicone/hl-06-datasets-empty.png)

**AcruxCore** — `hub.prompts.render` + `hub.gateway.chat`, one gateway hop, no OpenAI client at all:

![AcruxCore trace detail for a script-generated call, showing the expanded LLM span with Model, Provider, Tokens, Latency, and the real request/response JSON](/img/tutorials/comparison/acx-sdk-trace.png)

Both the Node and Python scripts' calls land on this same single-span trace page, just
with their own request ID and token count each run.

</details>

## Tools and tool-calling

:::info[Quick take]
Only AcruxCore treats a tool as a versioned, measured object. Everyone else shows a tool
call as a trace span or a per-session schema; MLflow catalogs external MCP servers instead
of individual tools.
:::

Across all eight platforms, only one treats a tool as a governed object the way it treats a
prompt — the rest can *show* a tool call somewhere, or catalog something adjacent to a tool,
but nothing else versions, executes, and measures an individual tool the way AcruxCore does.

- **LangSmith** — no separate tools section at all. When a traced chain includes a
  LangChain tool node, the tool call shows up as its own child span inside the trace (we saw
  this earlier: a `lookup_product_docs` span next to the `gpt-4o-mini` span in a real run) —
  but that's a side effect of tracing, not a registry. There's nowhere to list, version, or
  see aggregate call stats for a tool independent of the traces that happened to use it.
- **Langfuse** — the Playground has a **Tools** control, but it's scoped to that one
  Playground session: "Configure tools for your model to use," starting from "No tools
  attached," with a **Create new tool** action that defines a JSON schema for that run.
  Nothing here persists as a team-wide, reusable, versioned object — close the Playground
  tab and the tool definition is gone unless you paste it in again next time.
- **PromptLayer** — tracks a **Tool Calls** count as a field on every Request Log entry
  (ours read "0 Tool Calls"), and its Playground has a **Tools & Output** control for
  attaching a function schema to a run — the same per-session shape as Langfuse, just under
  a different name.
- **Phoenix** — its only surface is a "+ Tool" control inside the Playground's message
  editor: an ad-hoc JSON Schema for that one prompt run, never executed or measured.
- **Opik** — no schema-definition UI whatsoever. Its closest nav item, "Agent playground,"
  is a live-connection debugger — you add `@opik.track(entrypoint=True)` to a running
  agent's own code and run a terminal connector command, and it sits at "Disconnected"
  until that process connects. That's weaker than even Phoenix's placeholder schema dialog,
  which at least produces a stored (if unversioned) object from the UI.
- **Helicone** — no tool-catalog concept found in any nav section we checked (Segments,
  Improve, or Monitor).
- **MLflow** — the one genuine exception, and it answers a different question than
  AcruxCore does. Its **MCP Registry** (Beta) catalogs external
  [Model Context Protocol](https://modelcontextprotocol.io/) *servers* — paste a
  `server.json` manifest and it's discoverable by name, source repo, and tags. That's a
  real, persistent, versioned-feeling object, closer to AcruxCore's Tool Catalog than
  anything else here — but it answers "which MCP servers exist and are they reachable?",
  not "what did this specific tool call cost, and how often does it fail?" Nothing in
  MLflow's registry executes a tool call or records its latency; nothing in AcruxCore's
  catalog discovers external MCP servers. Neither model is strictly better — each is built
  for a different question.
- **AcruxCore** — the only one with a dedicated **Tools** section in the main navigation,
  separate from Prompts. A tool (we had one real one, `get_weather`) gets its own page with
  **Versions** and **Aliases** tabs — the identical versioning model prompts use — plus a
  standalone **Tool analytics** page that aggregates real call volume, error rate, and
  P50/P95 latency per tool, sourced from traced tool executions. Tools are first-class,
  reusable, governed objects here, not a byproduct of tracing, a one-off Playground schema,
  or (MLflow) a discovery catalog of external servers.

<details>
<summary>See the actual screens: tools on all eight platforms (Helicone had nothing to show)</summary>

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

## Pricing and free-tier limits

:::info[Quick take]
No hands-on pricing audit for LangSmith/Langfuse/PromptLayer here — the audited numbers for
Phoenix/Opik/MLflow/Helicone live on the [compare page](https://acruxcore.com/compare).
:::

We didn't do a full plan-by-plan pricing audit as part of this hands-on pass — plan
details and quotas change often enough that we'd rather point you at each platform's
current pricing page than publish numbers that go stale. The one concrete thing we did
see directly: PromptLayer's workspace was on a **Team Trial** ("Trial ends in 7 days") with
visible usage quotas (100,000 request logs/month, 7,500 evaluation cells/month, 10,000
workflow node executions/month on that plan). We didn't verify equivalent numbers for
LangSmith or Langfuse hands-on, so we're deliberately not guessing at them here.

**AcruxCore** is the one platform here where pricing isn't a moving target: it's open
source under Apache 2.0 and self-hostable, and free to use during the public beta — no
trial clock, no seat count, no usage quota to run into.

For Phoenix, Opik, MLflow, and Helicone, we did do that plan-by-plan audit — as its own
dated, sourced table rather than prose here, since a pricing or license change is then one
edit instead of five. See license, self-hosting, team structure, security, and community
stats (stars, contributors, latest release) for all four, next to AcruxCore, on the
[compare page](https://acruxcore.com/compare).

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

**Phoenix**
- **PXI**, a chat assistant docked in every page, seeded with suggestions like "Find
  critical issues" and able to answer questions about your own traces, not just the product.
- **Per-project data retention on a real schedule**, plus typed annotation configs
  (a Categorical `user_feedback` type, for instance) rather than one free-form rating.
- A genuine **LLM-evaluator vs. code-evaluator** split, drawn as its own diagram.

**Opik**
- **Guardrails** — a Topic guardrail and a PII guardrail, configurable per project, with a
  ready-to-run `opik.guardrails` snippet.
- **Test suites** — a dedicated pre-deployment regression object, distinct from Experiments,
  importable from a CSV/JSON file.
- No login wall at all on self-host — straight into a working project.

**MLflow**
- **Guardrails and Budgets on every Gateway endpoint** — Safety, PII, and custom content
  checks, plus real spend-limit policies with a reset period and an on-exceeded action.
- **Full Jinja2 prompt templates** — the only competitor in this whole series where the
  fixture's actual `{% if %}`/`{% for %}` logic didn't need flattening.
- An **MCP Registry** cataloging external Model Context Protocol servers, and a docked
  "MLflow Assistant" that can flag latency/correctness problems across recent traces.
- By far the largest, oldest project compared here — 27,000+ GitHub stars, 444
  contributors, shipping since 2018.

**Helicone**
- **Rate Limit Rules** — a real rule builder, separate from the BYOK routing bugs we hit
  elsewhere on this build.
- **Per-user request tracking via one header** (`Helicone-User-Id`) — no separate
  user-management setup at all.
- **Real-time Slack or email alerts** on error-rate or other thresholds.

**AcruxCore**
- **Stored-prompt gateway calls** — send a prompt name + alias, and the gateway renders
  and routes it in one request, with no client-side templating step at all.
- **Feedback-driven datasets** — eval data comes from real thumbs-up/down on production
  traces, not hand-authored fixtures.
- **Gateway-as-tracing-source** — every call is traced automatically because it physically
  routes through the gateway, not because an SDK wrapper is watching it.
- **Improve from feedback** — an automated loop that turns selected feedback rows into
  drafted prompt rewrites, runs the current production version and every candidate through
  an LLM judge, and lets you promote the winner in one click. None of the other seven
  connect feedback to a rewrite-and-promote path this directly.
- **A first-class, versioned Tool Catalog** with its own analytics page (call volume, error
  rate, latency per tool) — the other seven only expose tool calls as trace spans, per-session
  schema attachments, or (MLflow's MCP Registry) a catalog of external servers rather than
  individual tools; none execute and measure a tool call the way this does.
- **Gateway response caching** — cacheable calls can be served straight from the gateway.
  Helicone documents the identical idea (`Helicone-Cache-Enabled`) since it's also in the
  request path by design, but we never got a cached call to complete on this self-hosted
  build (see **Where the platform sits** above) — so this is AcruxCore's own verified,
  working feature next to Helicone's real but unverified-on-this-run one, not a feature
  unique to AcruxCore's architecture.
- **A second, full-parity SDK** — everything above is also available from Python
  (`pip install acruxcore`), not just the TypeScript client.

## Where AcruxCore stands

**Matches:**
- The alias/label-promotion model — immutable versions plus a movable pointer — is where
  LangSmith, Langfuse, PromptLayer, Phoenix, Opik, and MLflow all converge in some form, and
  roughly where AcruxCore already is, with a dedicated Diff tab covering the same ground as
  PromptLayer's, Phoenix's, Opik's, and MLflow's own diff views.
- Span-based automatic tracing puts AcruxCore level with LangSmith, Langfuse, Phoenix, and
  MLflow — ahead of PromptLayer's flat-by-default request log and Opik's Playground (which
  produces no trace at all).

**Ahead:** three genuine structural advantages, not just UI polish, held up across all
seven competitors:

1. The feedback → Playground → save loop that Langfuse and PromptLayer both have (and
   LangSmith doesn't) is fully present in AcruxCore too — plus a materially more automated
   version of it in **Improve from feedback**, which none of the seven competitors match.
2. The **Tool Catalog** treats tools as versioned, aliased, analytics-backed objects that
   actually execute and get measured, while every other platform here only ever shows a
   tool call as a trace span, a one-off Playground schema, or (MLflow's MCP Registry) a
   catalog of external servers rather than individual tools.
3. Being genuinely **in the request path** turns tracing, cost, and (when it works) caching
   into a side effect of the call itself rather than a separate instrumentation step — a
   design AcruxCore shares with only two of the seven competitors (MLflow, and Helicone by
   intent), and one where AcruxCore's own implementation is the one that actually worked on
   every run.

**Behind:** two real gaps stand out now — one new to this expanded pass, the other already
known and sharper with more evidence:

1. **Guardrails and spend controls** — Opik's Topic/PII guardrails, MLflow's Safety/PII
   guardrails plus enforced spend Budgets, and Helicone's Rate Limit Rules are all real,
   working features that AcruxCore has no answer for today; see
   **Guardrails and spend controls** above.
2. **Evaluation ergonomics** — LangSmith, Langfuse, Phoenix, and Opik all let a fresh
   account build a dataset in one sitting (some from hand-authored examples, some from any
   trace with one click), while AcruxCore's datasets are feedback-only: a brand-new account
   has *nothing* to build a first dataset from until real traffic and real thumbs-up/down
   accumulate. We still think feedback-driven evaluation is the more trustworthy long-term
   model, not a weaker one — the bootstrapping gap is the thing worth fixing, not the design
   choice behind it. LangSmith's Pairwise Experiments, PromptLayer's ad-hoc
   model-comparison grid, and Opik's dedicated Test suites are all things AcruxCore
   doesn't have an equivalent for today, independent of where the dataset comes from.

**Worth adopting:**
- Opik's or MLflow's guardrails (a Topic/PII check on input or output) would close the
  single largest capability gap this expanded comparison surfaced — AcruxCore has no
  content-inspection layer at all today.
- MLflow's enforced spend Budgets, once AcruxCore's cost tracking has customers who'd
  actually want a hard cap rather than just visibility.
- A lightweight, no-dataset-required comparison tool (PromptLayer's Model comparison) would
  remove the "nothing to evaluate yet" wall for brand-new AcruxCore accounts, without
  displacing the feedback-driven dataset model as the deeper, long-term path.
- A pairwise run-comparison view (LangSmith), once AcruxCore accounts typically have more
  than one experiment run to compare.
- Langfuse's session/user badges directly on the trace header are a small but genuinely
  nice affordance — AcruxCore supports session grouping, but we didn't verify a
  one-click badge-to-filter interaction as smooth as Langfuse's in this pass.

Nothing here suggests AcruxCore needs a different architecture — being in the request path
is a real structural advantage shared with only MLflow and (by design, if not on this run)
Helicone. The two real gaps — guardrails/spend controls and evaluation ergonomics for a
brand-new account — are product features to build, not a redesign.

Want the deepest look at any one of these seven, run as a real matched example rather than a
synthesis? Four got a full hands-on walkthrough of their own, and four got a dedicated
paired comparison against AcruxCore using the same fixture prompt each time:

- [Hands-on with LangSmith](/blog/langsmith-hands-on-walkthrough)
- [Hands-on with Langfuse](/blog/langfuse-hands-on-walkthrough)
- [A hands-on walkthrough of PromptLayer](/blog/promptlayer-hands-on-walkthrough)
- [Phoenix vs AcruxCore](/blog/acruxcore-vs-phoenix) — OpenTelemetry tracing depth against a request-path gateway.
- [Opik vs AcruxCore](/blog/acruxcore-vs-opik) — guardrails, PII, and online evaluation against a working Tool Catalog.
- [MLflow vs AcruxCore](/blog/acruxcore-vs-mlflow) — the closest structural match of any competitor here, two gateways compared directly.
- [Helicone vs AcruxCore](/blog/acruxcore-vs-helicone) — two request-path proxies, and the real self-hosted bugs we hit trying to use one of them.

And for the full license, pricing, team-structure, security, and community picture across
all seven competitors next to AcruxCore, see the [compare page](https://acruxcore.com/compare).

Want to see it for yourself? The [Quickstart](/docs/getting-started/quickstart)
gets you from sign-up to a traced, gateway-routed call in about ten minutes.
