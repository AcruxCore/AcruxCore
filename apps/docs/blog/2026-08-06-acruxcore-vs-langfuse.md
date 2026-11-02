---
title: "AcruxCore vs Langfuse: one app measured on both platforms"
description: "AcruxCore vs Langfuse: one agent run on both, with tracing code, prompt diffs, experiments, review queues, live latency and the price of 100,000 traces."
slug: acruxcore-vs-langfuse
authors: [acrux]
tags: [llmops-comparison, prompt-management, llm-tracing]
image: /img/blog/acruxcore-vs-langfuse/header.webp
keywords: [AcruxCore vs langfuse, langfuse vs AcruxCore, langfuse pricing, prompt versioning, llm gateway, llm tracing]
last_update:
  date: 2026-11-02
---

![AcruxCore vs Langfuse at a glance: license, self-hosting, gateway, review queue, alert channels and audit log for each product in a matched grid](/img/blog/acruxcore-vs-langfuse/header.webp)

Choose Langfuse if your team reviews model output by hand in a queue, wants cost or latency
alerts in Slack, builds on the Vercel AI SDK, or wants the largest open-source community in this
space. Choose AcruxCore if you want a gateway in the request path, versioned tools that the
platform runs, and an audit log, all free and open source, hosted or self-hosted, and your team
can review replies on the trace page.

The test app, its data, its prompts and its model were identical on Langfuse and AcruxCore. The
sections below give what we measured for tracing, prompts, experiments, review and live traffic,
and then list what each platform has that the other lacks.

We build AcruxCore. The scripts and run logs for both legs are in the repo, linked at the end.

<!-- truncate -->

## Differences at a glance

| | AcruxCore | Langfuse |
|---|---|---|
| License | Apache 2.0, every feature | MIT core; some features under a commercial license |
| Self-hosting | Free, every feature | Free core; project roles, audit log and retention policies need a license |
| Services to run when self-hosting | API, worker and web containers, Postgres, Redis | Web and worker containers, Postgres, ClickHouse, Redis or Valkey, S3-compatible storage |
| Hosted price, 100,000 traces a month, 3 people | $0; the hosted platform is free to use | $98.36 on the Core plan |
| Hosted free plan | The whole platform; no trace or seat limit is listed | 50,000 units a month, 2 users (a unit is a trace, a step or a score) |
| Gateway in the request path | Yes: fallbacks, cache, budgets, rate limits, virtual keys | No |
| Review queue for people | No | Yes: 1 queue on the free plan, 3 on Core, unlimited on Pro |
| Alerts | Email: budgets, evaluation rules, weekly digest | Cost, latency and scores; Slack, webhook, GitHub Actions |
| Vercel AI SDK integration | No | Yes |
| Roles | Owner, admin, editor and viewer on each team | Organization roles on every plan; project roles on Pro with the Teams add-on, or Enterprise |
| SSO | No | Hosted: Pro with the Teams add-on ($300 a month), or Enterprise. Self-hosted: Google, GitHub, Okta, Azure AD or a custom OAuth provider, and SSO is not on the licence-key list |
| Audit log | Every plan, also self-hosted | Enterprise |
| GitHub stars, 2 November 2026 | 12 | 36,881 |

Sources, read 2 November 2026: Langfuse [pricing](https://langfuse.com/pricing),
[self-hosting](https://langfuse.com/self-hosting),
[license](https://github.com/langfuse/langfuse/blob/main/LICENSE),
[alerts](https://langfuse.com/docs/observability/features/alerts) and
[Vercel AI SDK](https://langfuse.com/integrations/frameworks/vercel-ai-sdk),
[self-hosted SSO](https://langfuse.com/self-hosting/security/authentication-and-sso) and
[licence key](https://langfuse.com/self-hosting/license-key) pages, and
[acruxcore.com/pricing](https://acruxcore.com/pricing). The $98.36 figure comes from Langfuse's
pricing calculator on 16 October 2026. The [price section](#price-and-hosting) explains it.

## How we tested

The app is a small agent that reads a client's email. It checks each request against a signed
project scope, prices the extra work, and writes a reply. It runs in four steps: extract,
classify, price and reply.

- **Data:** 30 client messages, each with the expected items and total price.
- **Scorers:** exact items, exact total, and an LLM judge that reads the reply.
- **Prompts:** two versions. Version 2 rewrites the extract and classify prompts.
- **Model:** every call, the judge included, went to z.ai `glm-5.3` with `reasoning_effort="low"`,
  straight from the app.
- **Platforms:** Langfuse Cloud, EU region, free plan, `langfuse` 4.14.1. AcruxCore on
  acruxcore.com, `acruxcore` 0.18.0.
- **Dates:** 16 and 17 October 2026 for the app. On 2 November 2026 we added four checks on
  Langfuse Cloud (web app v4.72.0, `langfuse` 5.1.0): two prompt versions and the diff view, a
  prompt reference, `{% if %}` in a template, and the drop-in OpenAI wrapper.

The same app also ran on LangSmith. That three-way result is in
[AcruxCore vs Langfuse vs LangSmith](https://acruxcore.com/blog/acruxcore-vs-langfuse-vs-langsmith).

## Tracing

| | AcruxCore | Langfuse |
|---|---|---|
| Lines of tracing and prompt-fetching code for this app | 15 | 11 |
| Wrapped OpenAI client | No | Yes, `from langfuse.openai import openai` |
| Decorator that makes a function a step | `traces.step` | `@observe` |
| A model call shows its prompt version | As a link, "View traces for this prompt version", without the prompt's name or number | As a link, "prompt: scope-extract - v1" |
| Calls recorded with no code in your app | Through the gateway | No |

Both platforms stored the same tree for one message. The agent, named `scope-check`, sat at the
root. Under it came one span per step and one model call inside each step, and the price step was
marked as a tool.

<details>
<summary>Show screenshots: the same message traced in AcruxCore and Langfuse</summary>

![AcruxCore trace for one message: scope-check at the root, with extract, classify once for each of the two requests, a price tool and reply, each step holding a glm-5.3 LLM span, and 2,132 tokens and $0.00285 in the header](/img/blog/acruxcore-vs-langfuse-vs-langsmith/acx-trace-tree.jpg)

![Langfuse trace for the same message: scope-check at the root, with extract, two classify spans, a price tool and reply, each holding an OpenAI generation](/img/blog/langfuse-vs-langsmith/lf-trace-tree.jpg)

</details>

The Langfuse leg needed 4 fewer lines. The AcruxCore SDK has no wrapped OpenAI client, so 4 of
its 15 lines adapt the SDK's chat call to the `client.chat.completions.create` call that the app
makes.

For a single call, Langfuse needs no tracing code beyond the import. On 2 November 2026 we sent
one call through the drop-in wrapper, with no decorator and no context manager, and Langfuse
stored it as its own trace within 5 seconds. A decorator or a context manager is needed only to
group several calls into one trace, as the four-step app does.

On AcruxCore, a call through the gateway is traced with no SDK at all. You point the OpenAI
client at the gateway, and each call arrives as a priced span. Our test app called z.ai directly
on both platforms, so the gateway is not in the numbers in this post.

## Prompts: versions, diffs, promotion and rollback

| | AcruxCore | Langfuse |
|---|---|---|
| How a chat prompt is stored | A list of role and content messages | A list of role and content messages |
| Template logic | `{{ }}` variables, plus `if` and `for` blocks | `{{variable}}` substitution; `{% if %}` stays as plain text |
| Reuse one prompt inside another | No | Yes, a prompt reference in a text prompt |
| Names for the live version | `production` and `staging` aliases | `production`, `latest`, and labels you name yourself |
| SDK read without naming a label | No: every read names an alias | Returns the `production` version |
| Compare two versions | Diff tab: a unified diff between any two versions you pick | "Compare with selected prompt": the two versions side by side |
| Promote a version | 4 clicks, with a confirmation | 3 clicks, no confirmation |
| Roll back | 2 clicks on the same tab | 4 clicks |
| History of promotions | Audit tab: who moved the alias, from which version to which | Not shown on the prompt page |
| SDK cache before a promotion reaches a running app | 60 seconds | 60 seconds |

On 2 November 2026 we created two versions of the extract prompt on Langfuse Cloud: version 1
with the `production` label and version 2 with a label we named `candidate`. A read with no label
returned version 1, and reads of `candidate` and `latest` returned version 2. So on Langfuse, code
that does not name a label gets the production version, not a draft.

The Langfuse diff view showed the two stored versions side by side, with the removed text in red
and the added text in green, and a separate section for changes to the model config.

<details>
<summary>Show screenshot: Langfuse v1 to v2 prompt diff</summary>

![Langfuse "Changes v1 → v2" view for the extract prompt: version 1 on the left with "Return" marked as removed, version 2 on the right with the new paragraph about one request per kind of work marked as added, and Config: No changes](/img/blog/acruxcore-vs-langfuse/lf-prompt-diff-v1-v2.jpg)

</details>

AcruxCore's Diff tab shows a unified diff between the two versions you pick in "From" and "To".
This screenshot is from an earlier test prompt, so its text differs from the one above.

<details>
<summary>Show screenshot: AcruxCore Diff tab</summary>

![AcruxCore Diff tab for the vip-support-triage prompt: From v2 To v3, a unified diff in which the line "Keep the reply under 5 sentences." gains "Be concise and specific."](/img/comparison/acruxcore/acx-03-diff-tab.png)

</details>

The template engines differ. A Langfuse template fills `{{variables}}`. When we compiled the text
`{% if vip %}VIP customer. {% endif %}Hello {{name}}.`, Langfuse returned the `{% if %}` part
unchanged, so a branch like that has to be decided in your code before the call. Langfuse can
instead put one prompt inside another: a text prompt that contained
`@@@langfusePrompt:name=acxlf-rate-card|label=production@@@` came back from the SDK with the rate
card already filled in. AcruxCore templates take `if` and `for` blocks, and the server can fill in
the variables and return the finished messages.

<details>
<summary>Show screenshot: AcruxCore audit tab with promote and rollback</summary>

![AcruxCore Audit tab for scope-extract: production moved v1 → v2, then v2 → v1, each with who made the change and when](/img/blog/acruxcore-vs-langfuse-vs-langsmith/acx-audit-promote-rollback.jpg)

</details>

## Experiments over the dataset

An experiment answers one question: after you change a prompt, which messages got better and
which got worse? We ran the app over the 30 messages with version 1, then with version 2, and
opened each platform's comparison of the two runs.

| | AcruxCore | Langfuse |
|---|---|---|
| Upload the 30 test messages | 1 call, 1.0 s | 30 calls, 7.3 s |
| Run your own app code as an experiment | Yes, `run_local` | Yes, `run_experiment` |
| A plain Python `def` as the task | 4 messages at a time by default | One message at a time in `langfuse` 4.14.1, even with `max_concurrency=4`; an `async` task runs in parallel |
| Clicks to the comparison of two runs | 3, from the Evaluations page | 4, from the dataset page |
| Show only the messages whose score changed | Yes, the comparison opens that way | We found no such filter; we scanned all 30 rows |

On AcruxCore, version 2 fixed 2 messages on the items score and broke 2 others, and the
comparison page opened on those 4 messages. Langfuse's comparison showed both runs' scores side by
side for all 30 messages, with averages and up and down counts at the top.

<details>
<summary>Show screenshots: v1 vs v2 comparison in AcruxCore and Langfuse</summary>

![AcruxCore Compare per example: base v1, target v2, Changed 4 selected, two messages improved and two regressed on the items score](/img/blog/acruxcore-vs-langfuse-vs-langsmith/acx-local-compare-per-example.jpg)

![Langfuse comparison of the v2 run against the v1 run: a summary with averages, deltas and up/down counts, and rows with both runs' scores side by side](/img/blog/langfuse-vs-langsmith/lf-compare.jpg)

</details>

We do not compare the scores across the two platforms. `glm-5.3` gives a slightly different
answer each time, so a score gap between platforms is noise.

## Reviewing replies by hand

We asked one question about each of the 30 replies: "Would you send this reply to the client as
is?"

| | AcruxCore | Langfuse |
|---|---|---|
| Review queue | No | Yes |
| Clicks per reply | 4: open the trace, open the reply step, ▲ or ▼, go back | 2: a verdict and "Mark Completed" |
| The verdict names the question | No; a ▲/▼ rating on the step | Yes, a score configuration |
| Fix a wrong answer | A comment and a label on the trace | "Correct output" saves your text |

<details>
<summary>Show screenshot: Langfuse annotation queue</summary>

![Langfuse annotation queue: the message, output and reply as text on the left, True and False buttons for human_reply_ok on the right, and Mark Completed at the bottom](/img/blog/langfuse-vs-langsmith/lf-annotation-queue.jpg)

</details>

Langfuse's queue moves to the next reply after each verdict. On AcruxCore, a reviewer works from
the Traces list, which shows each trace's name rather than the client's message, so finding one
message means opening rows.

## Live traffic

We sent the 30 messages to both platforms in the same five minutes, one at a time, on
16 October 2026 between 17:17 and 17:22 UTC. Then we read the numbers back through each
platform's API.

| | AcruxCore | Langfuse |
|---|---|---|
| Latency p50 / p95 | 7.7 s / 10.6 s | 7.2 s / 10.8 s |
| Model cost per trace, paid to z.ai | $0.0016 | $0.0015 |

The latency is almost all model time, because both apps called the same z.ai endpoint. The model
cost is z.ai's bill for one message, not a platform fee. It differs because the model wrote
replies of different lengths.

## Price and hosting

| Plan | 3 people, 100,000 traces a month | Trace data kept |
|---|---|---|
| AcruxCore (hosted) | $0; the hosted platform is free to use | Message content 90 days; tokens, cost and timing are not deleted |
| Langfuse Core | $98.36; $119.69 if each trace also gets three scores | 90 days |

- Langfuse bills units. Each trace, each step inside it and each score is one unit. Our live
  traces averaged 9.67 units, so 100,000 traces are 967,000 units.
- Core costs $29 a month with 100,000 units included. Further units cost $8 per 100,000 up to
  1 million and $7 per 100,000 from 1 million to 10 million. 967,000 units cost $29 plus
  $69.36, which is $98.36. With three scores per trace, 1,267,000 units cost $29 plus $90.69,
  which is $119.69. The calculator gave these figures on 16 October 2026, and the rates were
  the same on 2 November 2026.
- The Langfuse bill grows with the steps in a trace. An agent with 30 steps per trace would use
  about 3.1 million units for the same 100,000 traces.
- Core has unlimited users, so 3 people cost nothing extra. The free plan keeps data for 30 days.
- The [AcruxCore pricing page](https://acruxcore.com/pricing) says the hosted platform is free to
  use and that no paid plan exists today.
- On both platforms, you pay the model provider yourself.

Both platforms can be self-hosted for free. AcruxCore runs on Postgres and Redis, and every
feature is under Apache 2.0. Langfuse also needs ClickHouse and S3-compatible storage, and its
project roles, audit log and retention policies need a license key. SSO is not on Langfuse's
licence-key list: a self-hosted instance sets up Google, GitHub, Okta, Azure AD or a custom OAuth
provider through environment variables.

## What Langfuse does that AcruxCore doesn't

- 👎 **A review queue.** Reviewers see one reply at a time, answer a named question, and move to the
  next with one click. The queue can be worked from the keyboard. AcruxCore has no queue.
- 👎 **Alerts on cost, latency and scores, sent to Slack, a webhook or GitHub Actions.** The free
  plan has 2 alerts and Core has 20. AcruxCore alerts by email only, on budgets and evaluation
  rules, and has no latency alerts.
- 👎 **A Vercel AI SDK integration**, through the `@langfuse/vercel-ai-sdk` package. AcruxCore has
  none.
- 👎 **A much larger community:** 36,881 GitHub stars on 2 November 2026, against 12 for
  AcruxCore.
- 👎 **Prompt references**, so one shared snippet can sit inside many prompts.
- 👎 **SSO**, on hosted Pro with the Teams add-on or on Enterprise, and on a self-hosted instance
  without a licence key. AcruxCore has no SSO.
- 👎 **A choice of hosted region:** US, EU or Japan. AcruxCore does not state its hosted region.

## What AcruxCore does that Langfuse doesn't

- 👍 **A gateway in the request path**, hosted or self-hosted, with
  [fallbacks](https://docs.acruxcore.com/docs/guides/automatic-model-fallbacks),
  [budgets and per-key limits](https://docs.acruxcore.com/docs/guides/set-spend-limits-with-gateway-budgets-and-rate-limits),
  virtual keys and an exact-match cache. Every call through it is traced and priced with no code
  in your app. Langfuse records the calls that your own code makes.
- 👍 **A versioned tool catalog.** You define a tool, version it and bind it to a prompt, and the
  gateway can run it. Each tool span records the tool version that ran.
- 👍 **An audit log on every plan**, which shows who moved each alias and between which versions.
  The [audit trail guide](https://docs.acruxcore.com/docs/guides/read-the-team-audit-trail)
  shows it.
- 👍 **Free self-hosting with every feature**, with Postgres and Redis as the only data services.

## Which one to choose

**Choose Langfuse** if people on your team review replies by hand every day, if you want alerts
in Slack, if you build on the Vercel AI SDK, or if you need SSO or a chosen data region. Plan for
about $98 a month at 100,000 traces of a four-step agent on Core, and more if your traces have
more steps.

**Choose AcruxCore** if you want the gateway, the tool catalog and the audit log without a paid
plan, or you must self-host with every feature. Expect to review replies on the trace page and to
receive alerts by email.

![Choose Langfuse if you review replies by hand, want alerts in Slack, build on the Vercel AI SDK or need SSO; choose AcruxCore if you want the gateway, tool catalog, audit log and free self-hosting](/img/blog/acruxcore-vs-langfuse/choose.webp)

AcruxCore also accepts OpenTelemetry traces on an
[OTLP endpoint](https://docs.acruxcore.com/docs/guides/send-otel-traces-with-the-sdk-helper),
so an app that is already instrumented with OpenTelemetry can send its traces there.

> **Key point:** The Langfuse bill depends on how many steps and scores each trace has, while the
> hosted AcruxCore platform is free to use. Langfuse is ahead on human review, alerts and community,
> and AcruxCore is ahead on calls that need to pass through a gateway.

## FAQ

### How much does Langfuse cost for 100,000 traces?

For our four-step agent, 100,000 traces were 967,000 units, which cost $98.36 a month on the Core
plan. With three scores per trace, the same traffic was 1,267,000 units and cost $119.69.

### How does Langfuse count units?

Each trace, each step inside it and each score is one unit. Core includes 100,000 units for $29 a
month, and further units cost $8 per 100,000 up to 1 million and $7 per 100,000 after that.

### Can you self-host Langfuse for free?

Yes. The self-hosted core is MIT licensed, and it needs Postgres, ClickHouse, Redis or Valkey and
S3-compatible storage. Project roles, the audit log and retention policies need a licence key.

### Does Langfuse have a review queue?

Yes. Langfuse's annotation queue shows one reply at a time with a named score, and the free plan
has 1 queue, Core 3 and Pro unlimited. AcruxCore has no review queue.

### What is the difference between Langfuse labels and AcruxCore aliases?

Both point a name at a prompt version. Langfuse has `production`, `latest` and labels you name
yourself, and a read with no label returns `production`. AcruxCore has `production` and `staging`
aliases, and every read names one.

### Is AcruxCore free?

The hosted AcruxCore platform is free to use, and no paid plan exists today. You pay your model
provider yourself, as you do with Langfuse.

## Run it yourself

:::github
- [`acruxcore-vs-langfuse/`](https://github.com/AcruxCore/AcruxCore/tree/main/scripts/blogs/acruxcore-vs-langfuse) — the 2 November checks on Langfuse Cloud and their run log.
- [`acruxcore-vs-langfuse-vs-langsmith/`](https://github.com/AcruxCore/AcruxCore/tree/main/scripts/blogs/acruxcore-vs-langfuse-vs-langsmith) — the app, the AcruxCore leg, the dataset, both prompt versions, and the raw output of every step.
- [`langfuse_leg.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/blogs/langfuse-vs-langsmith/python/langfuse_leg.py) — the Langfuse leg.
- [`RUNLOG.md`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/blogs/langfuse-vs-langsmith/RUNLOG.md) — the Langfuse leg's run log.
:::

## Further reading

- [AcruxCore vs Langfuse vs LangSmith](https://acruxcore.com/blog/acruxcore-vs-langfuse-vs-langsmith)
  adds LangSmith to the same test.
- [Langfuse vs LangSmith](https://acruxcore.com/blog/langfuse-vs-langsmith) runs the app on those
  two platforms only.
- [Langfuse alternatives](https://acruxcore.com/blog/langfuse-alternatives) covers more tools.
