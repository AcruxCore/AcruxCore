---
title: "Helicone vs AcruxCore: two request-path proxies compared"
description: We rebuilt the same support-triage prompt on self-hosted Helicone and AcruxCore, ran it on both — real screenshots, an SDK trace, and a latency benchmark.
slug: acruxcore-vs-helicone
authors: [acrux]
tags: [llmops-comparison, llm-gateway, llm-tracing]
image: /img/social-card.png
keywords: [helicone vs AcruxCore, helicone alternative, llm ops comparison, ai gateway, prompt versioning, llm tracing]
---

Helicone is a proxy-first LLM observability tool — you point your API base URL at it and
it sits in the request path, which makes it architecturally closer to AcruxCore's own
gateway than most competitors in this series. So we built the same prompt —
`vip-support-triage`, a support agent that changes tone for VIP customers and lists
their open tickets — on self-hosted Helicone, then tried to run the identical sequence
we've run on every platform in this series: create the prompt, send a live call,
inspect the trace, build a dataset, and call it from a script. On this self-hosted
build, three of those steps hit real, reproducible errors on Helicone's side before we
ever got a trace. We're publishing those errors, not routing around them — that's the
most useful thing we found.

<!-- truncate -->

:::note[Same example, both sides]
Every paired screenshot below comes from the exact same prompt and the exact same
customer message, aimed at the exact same downstream model (`openai/gpt-4o-mini` via
OpenRouter) on both platforms. Where Helicone's own request path or logging pipeline
failed before completing that call, we show the real error instead of a trace — that
failure **is** the finding for that aspect, not a gap we padded over. License,
pricing, team structure, and community stats live on the
[compare page](https://acruxcore.com/compare) instead of here — they were always tables, and a
price change there is one edit instead of three.
:::

### At a glance

| Aspect | Helicone | AcruxCore | Winner |
|---|---|---|---|
| Request-path gateway | Real design (caching, rate limits) but BYOK routing to a non-native provider 501s / hard-forwards to the wrong host | Routed our OpenRouter call successfully, every time | Depends |
| Prompt templating | Flat `{{ hc:var:type }}` substitution only | Real nunjucks `{% if %}` / `{% for %}` logic | AcruxCore |
| Playground | `/generate` returns 401 "Invalid session" on every attempt | Runs, shows cost/cache/latency inline | AcruxCore |
| Tracing pipeline | Manual-log endpoint 500s — self-host missing `S3_REGION` | Automatic single span, always written | AcruxCore |
| Tool catalog | No tool-catalog concept found anywhere in the nav | Versioned catalog, real executed calls, analytics | AcruxCore |
| Dataset creation | Built from Request rows — none existed, since no call ever logged | From real span-level trace feedback | AcruxCore |
| SDK & DX | Direct-call script ran; the log-to-Helicone call it makes 500s | Automatic side effect of `hub.gateway.chat()` | AcruxCore |
| Measured overhead | Every gateway request failed — zero timeable samples | -4ms (indistinguishable from zero, CI crosses it) | AcruxCore |
| Real friction hit | Auth + config bugs blocked every live-call path we tried | Nothing to instrument, zero extra code | AcruxCore |

License, pricing, team structure, security, and community stats: see
[AcruxCore vs Helicone on the compare page](https://acruxcore.com/compare).

Full breakdown, screenshots, and the verdict below.

## Where the platform sits — in the request path, or beside it

Unlike most competitors in this series, Helicone genuinely is a request-path product
by design: its Providers page lets you register 20+ providers for its "AI Gateway",
and its Cache and Rate Limits pages document real header-controlled response caching
(`Helicone-Cache-Enabled`) and rate limiting. Hands-on, routing a **non-native**
provider through it failed two different ways: `POST /v1/gateway/oai/v1/chat/
completions` forwards the `Authorization` header straight to `api.openai.com`
regardless of the OpenRouter key registered in Settings, and the generic
multi-provider path (`/v1/gateway/gateway/...`) returns a flat `HTTP 501 "Not
implemented"` — confirmed by reading the self-hosted `jawn` service's own compiled
source, where that handler is a stub. AcruxCore's gateway sits **in the request
path** too, and routed our OpenRouter call successfully on every one of the 100
benchmark rounds below.

<details>
<summary>Show screenshots: gateway provider setup on Helicone, telemetry on AcruxCore</summary>

![Helicone's Providers page with OpenRouter registered and "Enable for AI Gateway (BYOK)" checked — the feature the request-path proxy is supposed to use](/img/comparison/helicone/hl-04-gateway-provider.png)
![AcruxCore's Gateway Telemetry panel — provider, model, cost, cache status, and latency, all computed inline before the response is returned](/img/comparison/acruxcore/acx-04-playground-run.png)

</details>

| Feature | Helicone | AcruxCore |
|---|---|---|
| Where it sits | In the request path — caching and rate-limit headers are real, documented features | In the request path — every call routes through it |
| BYOK routing (non-native provider) | 501 on the generic path; hard-forwarded to the wrong host on the named path | Worked on 100/100 benchmark rounds |
| Caching, rate limits | Documented header controls (`Helicone-Cache-Enabled`, etc.) | Built in, applied before the provider call |

## Prompt authoring & versioning

AcruxCore's editor uses **nunjucks** — real `{% if %}` and `{% for %}` logic, so the
VIP branch and the ticket list live in the template itself. Helicone's Playground
templating is flat `{{ hc:var:type }}` substitution with a type annotation per
variable, so we had to flatten the VIP note and the ticket list into plain text before
saving the prompt — the same compromise a competitor forced in an earlier comparison.
Saving created a single `v0`, auto-labeled `production`; a second version never got
created because the next step (a live Run) is the one that's broken on this build.

<details>
<summary>Show screenshots: prompt editor and versions on both platforms</summary>

![Helicone's Playground with the recreated vip-support-triage system message, showing the flat {{ hc:company:string }} variable syntax and the Save Prompt dialog with our commit message about flattening the nunjucks logic](/img/comparison/helicone/hl-01-prompt-editor.png)
![Helicone's saved prompt detail page: v0, auto-labeled "production", model gpt-4o-mini, no second version or diff control visible with only one version saved](/img/comparison/helicone/hl-02-versions.png)
![AcruxCore's Diff tab showing a real unified diff between prompt version 2 and version 3](/img/comparison/acruxcore/acx-03-diff-tab.png)

</details>

AcruxCore's own prompt editor — real nunjucks conditionals and loops rendering VIP
status and the ticket list inline — is one sentence here; see the
[walkthrough](/blog/acruxcore-hands-on-walkthrough#2-create-a-prompt-version-it-and-promote-an-alias)
for the picture.

| Feature | Helicone | AcruxCore |
|---|---|---|
| Conditional templating | Flat `{{ hc:var:type }}` only — verified hands-on, no `{% if %}`/`{% for %}` | Real nunjucks `{% if %}`/`{% for %}`, rendered server-side |
| Version comparison | Not reached — only one version exists on this build | Standing **Diff** tab, unified diff between any two versions |
| Live label | `production` auto-applied to the first version | `production` / `staging` **aliases** your app fetches at runtime |

## Sending a live call

This is where the run stopped producing new evidence and started producing bugs.
Clicking **Run** in Helicone's Playground returns `{"error":"Invalid session","trace":
"isAuthenticated.error"}` every time, on every model, after a fresh login, and after
clearing local storage. Network inspection shows why: the request to
`/v1/playground/generate` carries a `helicone-authorization` header with an **empty
JWT token** (`"token":""`). AcruxCore's Playground, by contrast, ran the same prompt
and rendered the completion inline with cost, cache, and latency.

<details>
<summary>Show screenshots: Playground run — blocked on Helicone, working on AcruxCore</summary>

![Helicone's Playground after clicking Run: the response panel shows the literal JSON error {"error":"Invalid session","trace":"isAuthenticated.error"} instead of a completion](/img/comparison/helicone/hl-03-playground-blocked.png)
![AcruxCore Playground's Stored-prompt tab, showing the same completion plus a Gateway Telemetry panel with provider, cost, cache status, and latency](/img/comparison/acruxcore/acx-04-playground-run.png)

</details>

| Feature | Helicone | AcruxCore |
|---|---|---|
| Playground | `Run` 401s with an empty auth token on this self-hosted build | Runs against a **stored prompt reference**, shows cost/cache/latency inline |
| Requires a real key | Yes (OpenRouter, registered in Settings → Providers) | Yes |

## Tracing & observability

With the Playground blocked, we fell back to Helicone's other documented path:
call the provider directly, then POST the request/response pair to its manual-logging
endpoint (`/v1/trace/custom/log` self-hosted; `api.worker.helicone.ai/custom/v1/log` on
Helicone Cloud). The direct OpenRouter call succeeded. The log call returned
`HTTP 500 {"details":"Region is missing"}` — the self-hosted docker-compose ships its
`jawn` service without an `S3_REGION` env var, so its S3 client fails to construct
before the trace ever reaches ClickHouse. AcruxCore's trace, meanwhile, is written
automatically as a side effect of the gateway call — nothing to log by hand at all.

<details>
<summary>Show screenshots: Requests page on Helicone, trace detail on AcruxCore</summary>

![Helicone's Requests page still showing only its static "Integrate to see your requests" preview data — our real OpenRouter calls never appear because the log call failed](/img/comparison/helicone/hl-06-datasets-empty.png)
![AcruxCore's trace detail: one LLM span with model, provider, tokens, cost, and latency, linked back to the exact gateway request and prompt version](/img/comparison/acruxcore/acx-05-trace-detail.png)

</details>

| Feature | Helicone | AcruxCore |
|---|---|---|
| Trace shape | Not reached — the logging call 500s on this build | Single span per gateway call |
| How it's produced | Manual logging call, which failed on a missing S3 config | Automatic — a side effect of the gateway call |
| Links back to prompt version | Not reached | Yes — "View traces for this prompt version" |

## How tools are handled — schema registry, or execution

We checked every nav section — Segments (Sessions, Properties, Users, Cache, HQL),
Improve (Prompts, Datasets, Playground), Monitor (Rate Limits, Alerts) — and found no
tool-catalog concept anywhere in self-hosted Helicone: no schema builder, no execution
record, nothing. AcruxCore has a real **Tool Catalog** — callable functions, versioned
like prompts, with their own analytics page, wired into the gateway so a call is a
real, traced execution.

<details>
<summary>Show screenshot: tool analytics on AcruxCore</summary>

![AcruxCore's Tool analytics page — call volume, error rate, and P50/P95 latency per tool, aggregated from traced executions](/img/comparison/acruxcore/acx-08-tool-analytics.png)

</details>

AcruxCore's Tools page — a dozen real, versioned tools — is one sentence here; see the
[walkthrough](/blog/acruxcore-hands-on-walkthrough#7-a-versioned-tool-catalog) for the
screenshot.

| Feature | Helicone | AcruxCore |
|---|---|---|
| Tool catalog | Not found in any nav section checked | Persistent, versioned catalog with its own page |
| Execution | Not applicable — no catalog object to execute | Real, gateway-executed calls |
| Tool analytics | Not available | Calls, error rate, and latency per tool |

## Evaluation & datasets

Helicone's Datasets page is explicit about where rows come from: "Create Your First
Dataset" links straight to the Requests page, meaning a dataset is curated from real
logged requests. Because no request of ours ever landed in Helicone (see **Tracing &
observability** above), the Requests table held nothing but static preview data, and
there was nothing to curate into a dataset. AcruxCore builds datasets from real
span-level trace feedback, which we captured via the frozen fixture in an earlier run.

<details>
<summary>Show screenshot: empty Datasets page on Helicone</summary>

![Helicone's empty Datasets page: "Create Your First Dataset — Curate your dataset from requests data," with a Go to requests button, since no request rows exist](/img/comparison/helicone/hl-06-datasets-empty.png)

</details>

AcruxCore's dataset — built from a real feedback row, since the vip-support-triage
trace's own single-span feedback wasn't eligible — is one sentence here; see the
[walkthrough](/blog/acruxcore-hands-on-walkthrough#5-build-a-dataset-from-real-feedback)
for the screenshot.

| Feature | Helicone | AcruxCore |
|---|---|---|
| Dataset creation | From real Request rows only — none existed on this run | From trace feedback only — and only **span-level** feedback |
| Experiments | Not reached | Version × model sweep with an automatic baseline |

## SDK & developer experience

AcruxCore's SDK has dedicated surfaces — `hub.prompts.render()` then
`hub.gateway.chat()` — and the trace is automatic. Helicone has no stored-prompt SDK
call to make in this situation, so our script calls OpenRouter directly with `requests`
and then attempts Helicone's manual-log call — which is the same call that 500s above.

```python title="acx_sdk_run.py"
rendered = await hub.prompts.render("vip-support-triage", "production", VARIABLES)
result = await hub.gateway.chat(
    rendered.model, rendered.messages,
    temperature=0, max_tokens=256,
    prompt_version_id=rendered.version_id,
)
```

```python title="hl_trace_run.py"
res = requests.post("https://openrouter.ai/api/v1/chat/completions", ..., json=body)
log_res = requests.post(f"{HELICONE_BASE_URL}/v1/trace/custom/log", ..., json=log_body)
# log_res.status_code == 500 — "Region is missing"
```

The AcruxCore call produced a real trace within seconds. The Helicone script's
completion succeeded; its logging call reproduced the exact 500 from **Tracing &
observability** above, every time we ran it. AcruxCore's SDK-produced trace is one
sentence here; see the
[walkthrough](/blog/acruxcore-hands-on-walkthrough#doing-this-from-code) for the
screenshot.

Full scripts: [`acx_sdk_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/helicone-vs-acruxcore/python/acx_sdk_run.py)
and [`hl_trace_run.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/comparison/helicone-vs-acruxcore/python/hl_trace_run.py).

| Feature | Helicone | AcruxCore |
|---|---|---|
| SDK model | Call the provider yourself, then manually log the pair | Dedicated `hub.prompts` / `hub.gateway` surface |
| Getting a trace | Manual-log call 500s on this self-hosted build | Automatic side effect of `hub.gateway.chat()` |

## Latency overhead — measured

We timed the identical fixed call three ways, interleaved in rotating order over 100
rounds: a raw direct call to OpenRouter (baseline), the same call through Helicone's
`/v1/gateway/oai` proxy, and the same call through AcruxCore's gateway. Unlike
client-side instrumentation cost, both Helicone's and AcruxCore's overheads would be
the cost of an extra network hop — if Helicone's leg had completed even once.

| Path | median | p95 | p99 | successful rounds |
|---|---|---|---|---|
| Direct to provider | 986 ms | 1393 ms | 2120 ms | 100/100 |
| Helicone AI Gateway | — | — | — | **0/100** |
| AcruxCore gateway | 976 ms | 1606 ms | 1872 ms | 100/100 |

Helicone's leg failed all 100 rounds with the same `401 Unauthorized` from
**Where the platform sits** above — an OpenRouter key rejected by an endpoint that
only forwards to `api.openai.com`. There is no latency number to report for it, and
we're not estimating one. AcruxCore's measured gap against the direct-call baseline
is **-4ms, with a 95% bootstrap CI of [-136, +124]ms — the interval crosses zero**, so
this run's overhead is statistically indistinguishable from zero at this sample size.

For a broader run — real OpenAI billing instead of OpenRouter, six platforms in one
interleaved benchmark, and four independent runs to check how stable the numbers
are — see
[full-cycle latency across six LLM-ops platforms](/blog/full-cycle-latency-benchmark).

## Friction hit during this run

Real friction hit while doing this comparison, not a symmetric wish list.

**Helicone**
- 👍 Registering a provider key for its "AI Gateway" (Settings → Providers) took one
  form and immediately showed "1 key configured" — the UI itself is polished.
- 👍 Response caching and rate limiting are real, documented, header-controlled
  features — not something we had to infer.
- 👎 The Playground's `Run` button 401s with an **empty JWT token** in its own auth
  header, on every attempt, on a fresh login.
- 👎 The generic multi-provider gateway route returns a hardcoded `"Not implemented"`
  — a stub, not a partial implementation.
- 👎 The manual-logging endpoint 500s on a missing `S3_REGION` env var that the
  self-hosted `docker-compose` never sets.
- 👎 "Add New Member" has no role selector at all — just an email field.

**AcruxCore**
- 👍 Nothing to instrument — `hub.gateway.chat()` (or the Playground) writes the trace
  as a side effect, no wrapper client, no manual logging call.
- 👍 Every gateway call in the 100-round benchmark succeeded — no auth or config
  surprises.
- 👎 A model with no registered per-1M rate shows a blank `—` cost instead of `$0` or
  an estimate, until you register one.

## What Helicone does that AcruxCore doesn't

Sourced from Helicone's own dashboard, not from this post's earlier aspects — those
carry the same bias any of our own feature list would, and this run's bugs shouldn't
be read as "Helicone has nothing real to offer."

**Rate Limit Rules — a real rule builder, separate from the broken BYOK gateway
path.** Monitor → Rate Limits has two tabs: Rate Limited Requests (a live chart) and
Rate Limit Rules, where "Create Rule" opens a genuine rule builder. AcruxCore enforces
RPM and TPM limits per virtual key, but has no rule object that can scope a limit to an
individual end user the way a Helicone rule can.

<details>
<summary>Show screenshot: Rate Limit Rules on Helicone</summary>

![Helicone's Rate Limit Rules tab: "No rate limits defined yet. Create your first rate limit rule to get started," with a Create Rule button](/img/comparison/helicone/hl-14-rate-limit-rules.png)

</details>

**Per-user request tracking via a single header.** The Users page tracks per-user
request volumes and usage patterns the moment a caller adds one header
(`Helicone-User-Id: john@doe.com`) to a request — no separate user-management setup.
AcruxCore's tracing has no per-end-user dimension at all today.

<details>
<summary>Show screenshot: per-user request tracking on Helicone</summary>

![Helicone's "Start Tracking User Metrics" empty state: "Start tracking per-user request volumes and usage patterns with a simple header: Helicone-User-Id: john@doe.com"](/img/comparison/helicone/hl-15-per-user-tracking.png)

</details>

**Alerts — real-time Slack or email notifications on error-rate or other
thresholds.** "Create Your First Alert" wires a threshold directly to a Slack channel
or an email address. AcruxCore has no alerting surface — you have to go look.

<details>
<summary>Show screenshot: Alerts on Helicone</summary>

![Helicone's Alerts empty state: "Create Your First Alert — Receive real-time notifications in Slack or via email when something goes wrong," with a Create Alert button](/img/comparison/helicone/hl-16-alerts.png)

</details>

All three are genuinely useful, and none of them touched the bugs we hit elsewhere in
this post — Rate Limit Rules and Alerts are configuration surfaces, not request-path
code, so they didn't need the same `S3_REGION` or BYOK routing to work correctly.

## Verdict

| | Helicone | AcruxCore |
|---|---|---|
| Strongest at | A genuinely proxy-first design with real caching/rate-limit controls; per-user request tracking via one header; real-time Slack/email alerting | Every live-call path actually worked — Playground, SDK, gateway, all 100/100 benchmark rounds |
| Weakest at | On this self-hosted build: Playground auth, generic gateway routing, and manual logging all failed with real, reproducible errors | No per-user tracking dimension; no rate-limit-rule object; no alerting surface |
| Pick it if | You want a proxy-first tool with per-user tracking and alerting, and can either use its native providers or debug the BYOK path yourself on self-host | You want every step — prompt, call, trace, dataset — to work the first time, with nothing to route around |

The honest headline of this comparison isn't "AcruxCore wins every row" — it doesn't;
Helicone's rate-limit rules, per-user tracking, and alerting (**What Helicone does that
AcruxCore doesn't** above) are real capabilities AcruxCore has no answer for. It's
that on a **self-hosted build acquired mid-transition to maintenance mode**, three
independent, verifiable bugs — an empty auth token in the Playground, a stub gateway
handler, and a missing `S3_REGION` env var — blocked every live-call path we tried.
AcruxCore's equivalent paths (**Sending a live call**, **Tracing & observability**,
**Latency overhead** above) all worked, all 100 times we measured. See the full
picture, including license, pricing, and team structure, on the
[compare page](https://acruxcore.com/compare).

Want to run this yourself? The [Quickstart](/docs/getting-started/quickstart) gets you
from sign-up to a traced, gateway-routed call in about ten minutes.
