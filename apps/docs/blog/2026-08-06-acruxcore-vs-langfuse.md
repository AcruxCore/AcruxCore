---
title: "Langfuse vs Acrux Core: the same prompt, run for real on both"
description: We rebuilt the same support-triage prompt on Langfuse and Acrux Core and ran the identical sequence on both — real screenshots, a real SDK trace, and a measured latency benchmark, not a feature table copied from docs.
slug: acruxcore-vs-langfuse
authors: [acrux]
tags: [comparison, langfuse, llm-ops]
image: /img/social-card.png
keywords: [langfuse vs acrux core, langfuse alternative, llm ops comparison, prompt versioning, ai gateway, llm tracing]
---

Langfuse is the LLM-ops platform we get compared to most often, and it deserves a real
answer, not a table copied from two docs sites. So we built the same prompt —
`vip-support-triage`, a support agent that changes tone for VIP customers and lists
their open tickets — on both platforms, then ran the identical sequence on each: create
the prompt, version it, send a live call, inspect the trace, build a dataset, run an
experiment, and call it from an SDK script. Both products are open source today, so this
isn't about who's open — it's about what each one is actually shaped like.

<!-- truncate -->

:::note[Same example, both sides]
Every paired screenshot below comes from the exact same prompt and the exact same
customer message, sent through the exact same downstream model
(`openai/gpt-4o-mini` via OpenRouter) on both platforms. Where a step is genuinely
one-sided — no equivalent screen exists on the other product — we say so instead of
padding it out.
:::

## 1. Prompt authoring & versioning

Acrux Core's editor uses **nunjucks** — real `{% if %}` and `{% for %}` logic, so the
VIP branch and the ticket list live in the template itself. Langfuse's templating is
flat `{{variable}}` substitution only, so we had to pre-render the VIP note and the
ticket list into plain strings before the prompt ever saw them — Langfuse's own commit
message on the recreated prompt says so explicitly.

![Langfuse's create-prompt screen for the recreated vip-support-triage prompt, with a commit message noting it was adapted from Acrux Core's nunjucks template since Langfuse only supports flat variable substitution](/img/tutorials/langfuse-vs-acruxcore/lf-01-prompt-editor.png)
![Langfuse's prompt versions list showing a single version — no diff or compare control anywhere in the version history UI](/img/tutorials/langfuse-vs-acruxcore/lf-02-versions.png)
![Acrux Core's prompt editor showing the real nunjucks conditional and loop syntax rendering VIP status and the ticket list inline](/img/tutorials/langfuse-vs-acruxcore/acx-01-prompt-editor.png)
![Acrux Core's Diff tab showing a real unified diff between prompt version 2 and version 3](/img/tutorials/langfuse-vs-acruxcore/acx-03-diff-tab.png)

| Feature | Langfuse | Acrux Core |
|---|---|---|
| Conditional templating | Flat `{{variable}}` only — verified hands-on, no `{% if %}`/`{% for %}` | Real nunjucks `{% if %}`/`{% for %}`, rendered server-side |
| Version comparison | No diff/compare control found in the version history UI | Standing **Diff** tab, unified diff between any two versions |
| Live/staging labels | `production` / `latest` labels on a version | `production` / `staging` **aliases** your app fetches at runtime |

## 2. Sending a live call

Both need a real connected model before anything runs — neither offers a free trial
call. With that in place, both Playgrounds render the exact same reply from the exact
same inputs.

![Langfuse Playground with the recreated prompt loaded, showing the real completion in the Output panel](/img/tutorials/langfuse-vs-acruxcore/lf-03-playground-run.png)
![Acrux Core Playground's Stored-prompt tab, showing the same completion plus a Gateway Telemetry panel with provider, cost, cache status, and latency](/img/tutorials/langfuse-vs-acruxcore/acx-04-playground-run.png)

| Feature | Langfuse | Acrux Core |
|---|---|---|
| Playground | Runs against any connected model, no telemetry shown inline | Runs against a **stored prompt reference**, shows cost/cache/latency inline |
| Requires a real key | Yes | Yes |

## 3. Tracing & observability

Same call, two different trace shapes. Acrux Core's trace is one span, written as a
side effect of the gateway call itself. Langfuse's is a two-level tree — a parent
span wrapping the generation — because its SDK instruments the call rather than
routing it.

![Langfuse's trace detail: a two-node span tree (request span + generation span), 1.81s latency, $0.000048 cost, 154 total tokens](/img/tutorials/langfuse-vs-acruxcore/lf-04-trace-detail.png)
![Acrux Core's trace detail: one LLM span with model, provider, tokens, cost, and latency, linked back to the exact gateway request and prompt version](/img/tutorials/langfuse-vs-acruxcore/acx-05-trace-detail.png)

| Feature | Langfuse | Acrux Core |
|---|---|---|
| Trace shape | Span tree (request + generation) | Single span per gateway call |
| How it's produced | Client-side OTel instrumentation | Automatic — a side effect of the gateway call |
| Links back to prompt version | Not surfaced in this run | Yes — "View traces for this prompt version" |

## 4. The gateway asymmetry

Acrux Core's gateway sits **in the request path**: every call is routed through it, so
BYOK provider selection, caching, budgets, and virtual keys all apply before the
provider is ever called, and the trace is a side effect of that same hop. Langfuse
isn't a request-path product — it ingests a trace *after* your own client made the
call — so there's nothing to route, cache, or budget against on its side. That's a
structural difference in what each product is, not something Langfuse does worse.

![Acrux Core's Gateway Telemetry panel — provider, model, cost, cache status, and latency, all computed inline before the response is returned](/img/tutorials/langfuse-vs-acruxcore/acx-04-playground-run.png)

| Feature | Langfuse | Acrux Core |
|---|---|---|
| Request-path gateway | No — call providers yourself, trace is reported after | Yes — every call routes through it |
| BYOK, caching, budgets, virtual keys | Not applicable — no request path to apply them to | Built in, applied before the provider call |

## 5. Tool/agent instrumentation

Acrux Core has a real **Tool Catalog** — callable functions, versioned like prompts,
with their own analytics page. Langfuse has nothing like it: the closest thing is a
"Create new tool" button tucked inside the Playground, which just defines a JSON
Schema for function-calling and saves it project-wide — we made one, reloaded the page
in a fresh window, and it was still there, offered back to us in the same combobox. So
it persists, but that's all it does: no catalog page, no list view outside that one
dropdown, no version history, no analytics, and nothing actually *executes* it —
Langfuse hands the schema to the model and stops there. Acrux Core's tools are wired
into the gateway, so a call is a real, traced execution with its own cost and latency,
not just a shape the model is told about.

![Langfuse's Create LLM Tool dialog in the Playground, defining get_ticket_priority with a JSON Schema parameter](/img/tutorials/langfuse-vs-acruxcore/lf-13-tool-create.png)
![Langfuse's saved tool re-appearing in the Playground's tool picker after a full page reload, confirming it's stored project-wide, not per-session](/img/tutorials/langfuse-vs-acruxcore/lf-15-tool-persists.png)
![Acrux Core's Tools page listing a dozen real, versioned tools including get_order_status, query_database, and get_weather](/img/tutorials/langfuse-vs-acruxcore/acx-06-tools-catalog.png)
![Acrux Core's Tool analytics page — call volume, error rate, and P50/P95 latency per tool, aggregated from traced executions](/img/tutorials/langfuse-vs-acruxcore/acx-08-tool-analytics.png)

| Feature | Langfuse | Acrux Core |
|---|---|---|
| Tool catalog | A schema saved from the Playground, reusable project-wide, but no dedicated page or list view | Persistent, versioned catalog with its own page |
| Execution | None — the schema is shown to the model, never run | Real, gateway-executed calls |
| Tool analytics | Not available | Calls, error rate, and latency per tool |

## 6. Evaluation & datasets

Both build datasets and run experiments against them, but the on-ramp differs.
Langfuse lets you type a dataset item by hand or pull one from a trace; Acrux Core
builds datasets **only** from real feedback on a trace — and specifically, only from
**span-level** feedback, so a single-span trace's own thumbs-up can't be turned into a
dataset (we hit this directly and had to reuse a trace with more than one span).

![Langfuse's Create dataset item dialog, with the flattened input variables and a hand-written expected output](/img/tutorials/langfuse-vs-acruxcore/lf-06-dataset-item.png)
![Langfuse's experiment result row: real input/output pairs, but Total Cost showing $0.00 for a custom model without registered pricing](/img/tutorials/langfuse-vs-acruxcore/lf-08-experiment-result.png)
![Acrux Core's dataset built from a real feedback row, since the vip-support-triage trace's own single-span feedback wasn't eligible](/img/tutorials/langfuse-vs-acruxcore/acx-10-dataset.png)
![Acrux Core's Run report for that dataset against gpt-4o-mini — a plain, unscored manual run](/img/tutorials/langfuse-vs-acruxcore/acx-11-experiment-run.png)

| Feature | Langfuse | Acrux Core |
|---|---|---|
| Dataset creation | Manual entry, API, or from a trace | From trace feedback only — and only **span-level** feedback |
| Experiments | Prompt × model matrix, evaluator step in the wizard | Version × model sweep with an automatic baseline |
| Cost accounting we actually saw | $0.00 for an unregistered custom model | Real per-call cost, computed inline |

## 7. SDK & developer experience

Same call, two SDK philosophies. Acrux Core's SDK has dedicated surfaces —
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

![Langfuse's trace for the script-generated call: same VIP reply, 1.81s latency, $0.000048, OpenTelemetry SDK metadata visible](/img/tutorials/langfuse-vs-acruxcore/lf-09-sdk-trace.png)
![Acrux Core's trace for the script-generated call: 144 tokens, $0.0000414, 1.90s latency, linked gateway request](/img/tutorials/langfuse-vs-acruxcore/acx-09-sdk-trace.png)

Full scripts: [`acx_sdk_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/blogs/acruxcore-vs-langfuse/python/acx_sdk_run.py) and [`lf_trace_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/blogs/acruxcore-vs-langfuse/python/lf_trace_run.py).

| Feature | Langfuse | Acrux Core |
|---|---|---|
| SDK model | Wrap your own client (`langfuse.openai`) | Dedicated `hub.prompts` / `hub.gateway` surface |
| Getting a trace | Requires an explicit observation context | Automatic side effect of `hub.gateway.chat()` |

## 8. Latency overhead — measured

We timed the identical call three ways, interleaved in rotating order over 100 rounds
so a network blip hits all three equally: a raw direct call to OpenRouter (baseline),
the same call wrapped in Langfuse's SDK, and the same call through Acrux Core's
gateway. This measures two different kinds of overhead — Langfuse's is client-side
instrumentation cost, Acrux Core's is an extra network hop that buys routing, caching,
and tracing — not a rigged head-to-head.

| Path | median | p95 | p99 |
|---|---|---|---|
| Direct to provider | 999 ms | 1551 ms | 1940 ms |
| Langfuse SDK | 1015 ms | 1775 ms | 2189 ms |
| Acrux Core gateway | 1243 ms | 2078 ms | 2488 ms |

With a 95% bootstrap confidence interval on the gap against the direct-call baseline:
Langfuse's **+15ms is statistically indistinguishable from zero** (CI [-90, +150]ms) —
its instrumentation cost doesn't clear the noise floor at this sample size. Acrux
Core's **+260ms is real** (CI [+157, +360]ms) — the cost of the extra hop, not a
measurement artifact.

## 9. Developer experience — what actually surprised us

Real friction hit while doing this comparison, not a symmetric wish list.

**Langfuse**
- 👍 Self-hosting was fast — one `docker compose up`, working on first login.
- 👍 The experiment wizard validates your dataset variables against the prompt *before* it spends a call.
- 👎 Flat templating pushed the VIP-branch and ticket-list logic back onto the caller (see [aspect 1](#1-prompt-authoring--versioning)).
- 👎 The Playground doesn't produce a trace — only a scripted SDK call does.
- 👎 A doc example called `start_as_current_span`, which doesn't exist on SDK 4.14.1; the real method is `start_as_current_observation`.

**Acrux Core**
- 👍 Nothing to instrument — `hub.gateway.chat()` (or the Playground) writes the trace as a side effect, no wrapper client.
- 👍 Nunjucks conditionals and loops are real template logic, not something you flatten by hand first.
- 👎 A model with no registered per-1M rate shows a blank `—` cost instead of `$0` or an estimate, until you register one.

**Time-to-first-trace:** Acrux Core gets there on the first call with zero
tracing-specific code. Langfuse gets there too, but only through the SDK path, and only
after wrapping a client and opening an observation context.

## 10. Open source & self-hosting

Both are open source, under different terms. Acrux Core is **Elastic License 2.0** —
source-available: read it, modify it, self-host it, but don't resell it as a hosted
service. Langfuse splits its repo: the core is **MIT**, genuinely permissive, while its
`ee/` directories carry a separate Enterprise License gating specific features — which
is exactly why this post's audit-log screenshot (aspect 13) shows a locked door on
self-hosted Langfuse. Both ship a Docker Compose path for local self-hosting; this post
used exactly that for Langfuse.

| Feature | Langfuse | Acrux Core |
|---|---|---|
| License | MIT core + separate Enterprise License on `ee/` | Elastic License 2.0 (source-available, not permissive) |
| Self-host path | `docker compose up` | Postgres + Node stack |

## 11. Team & org structure

Langfuse has a real two-level hierarchy — organization above project — visible as a
breadcrumb on every settings page. Acrux Core is deliberately flatter: one team, one
member list, no separate layer above it.

![Langfuse's Project Settings showing the org (AcruxCore) → project (Demo) breadcrumb and hierarchy in the debug metadata](/img/tutorials/langfuse-vs-acruxcore/lf-10-org-project.png)
![Acrux Core's single Team page — members, invites, and team API keys together, no org layer above](/img/tutorials/langfuse-vs-acruxcore/acx-12-team.png)

| Feature | Langfuse | Acrux Core |
|---|---|---|
| Structure | Organization → project hierarchy | Single team-scoped model |
| Best fit | Many separate workspaces under one org | One team, one place to look |

## 12. Pricing

As of 2026-08-06. Acrux Core is free during beta, bring-your-own provider keys, no
published paid tier yet. Langfuse's hosted cloud (langfuse.com/pricing):

| Tier | Price/mo | Included |
|---|---|---|
| Hobby | Free | 50k units/mo, 30-day data access, 2 users |
| Core | $29 | 100k units/mo, 90-day data access, unlimited users |
| Pro | $199 | 100k units/mo, 3-year data access, SOC2/ISO27001, HIPAA BAA available |
| Enterprise | $2,499 | Audit logs, SCIM API, custom rate limits, dedicated support |

Notice that Langfuse's audit logs — the feature gated in aspect 13 below — are an
**Enterprise-tier** ($2,499/mo) feature on hosted Langfuse too, not just a self-host
limitation.

## 13. Security, access control & data handling

Only rows for what we actually saw — nothing assumed either way.

![Acrux Core's team-wide Capture payloads toggle, on by default](/img/tutorials/langfuse-vs-acruxcore/acx-13-capture-payloads.png)
![Acrux Core's per-prompt Audit tab with real entries — version commits and alias promotions](/img/tutorials/langfuse-vs-acruxcore/acx-14-prompt-audit.png)
![Langfuse's Project Members table with a two-tier RBAC model — Organization Role set to Owner, but Project Role reading "N/A on plan"](/img/tutorials/langfuse-vs-acruxcore/lf-11-members-roles.png)
![Langfuse's Audit Logs settings page stating plainly that audit logs are an Enterprise feature](/img/tutorials/langfuse-vs-acruxcore/lf-12-audit-logs-gated.png)

| Feature | Langfuse | Acrux Core |
|---|---|---|
| RBAC | Two-tiered (org role + project role) by design, but **Project Role reads "N/A on plan"** on this account | Single role per team member, no org-level layer |
| Audit log | Present in the UI, **gated behind the Enterprise plan** | Present and populated by default, no upgrade needed — but scoped to one prompt at a time |
| Payload/data capture control | Not found in any settings page checked | Team-wide `Capture payloads` toggle, on by default |

Neither story is simply "better": Langfuse's model is broader by design — org/project
RBAC, a team-wide audit log — but a real chunk of it sits behind a paid plan even for a
self-hosted admin. Acrux Core's audit trail is free and on by default, but narrower —
one prompt at a time, not the whole team.

## 14. Community & maturity

A footnote, not a scored comparison. Retrieved live from each project's own GitHub
page, 2026-08-06:

| | Langfuse | Acrux Core |
|---|---|---|
| Stars | 32,617 | 2 |
| Latest release | v4.5.0 | none tagged yet |
| Repo age | Multi-year, active | Opened 2026-08-03 |
| Contributors | 30 | Not yet computed by GitHub |

Langfuse is a mature, widely-used project. Acrux Core's public mirror is three days
old. Both facts matter to someone deciding what to depend on.

## 15. Verdict

| | Langfuse | Acrux Core |
|---|---|---|
| Strongest at | Tracing depth, org/project structure, eval tooling maturity | A request-path gateway with routing, caching, and budgets on every call; tools that actually execute and get measured, not just described; datasets built straight from real production feedback |
| Weakest at | No request-path gateway; tools are a schema in a Playground dropdown, not a catalog; RBAC and audit gated behind paid tiers | Narrower eval ecosystem and community maturity; audit scoped per-prompt |
| Pick it if | You want mature, OTel-native observability layered onto a client you already own | You want the provider call itself — gateway, tools, feedback-driven datasets — traced for free, with nothing bolted on after the fact |

Tracing depth and eval-tooling maturity are real Langfuse wins — [aspect 3](#3-tracing--observability)
and its years of usage show that. But on the three things that make up the actual
day-to-day loop of running an LLM app — the gateway, the tool catalog, and building
datasets from feedback — this comparison came down in Acrux Core's favor every time,
not just "different shape." Langfuse has no request-path gateway at all
([aspect 4](#4-the-gateway-asymmetry)), its "tool" is a schema saved from a Playground
dropdown that's never actually executed ([aspect 5](#5-toolagent-instrumentation)), and
its datasets are built by hand or pulled from a trace, not generated from feedback
your users already gave ([aspect 6](#6-evaluation--datasets)). Acrux Core does all
three natively, in one integrated flow.

Want to run this yourself? The [Quickstart](/docs/getting-started/quickstart) gets you
from sign-up to a traced, gateway-routed call in about ten minutes.
