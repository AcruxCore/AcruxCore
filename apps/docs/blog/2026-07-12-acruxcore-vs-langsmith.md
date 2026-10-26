---
title: "AcruxCore vs LangSmith: one app measured on both platforms"
description: "AcruxCore vs LangSmith: one agent run on both, with tracing code, prompt rollout, experiments, review clicks, live latency and the price of 100,000 traces."
slug: acrux-core-vs-langsmith
authors: [acrux]
tags: [llmops-comparison, prompt-management, llm-tracing]
image: /img/social-card.png
keywords: [AcruxCore vs langsmith, langsmith alternative, langsmith pricing, llm gateway, prompt management, llm tracing, llm evaluation]
last_update:
  date: 2026-10-25
---

Choose LangSmith if your team reviews model output by hand in a queue, needs a Go or Java SDK,
or needs custom SSO, and $567 a month for 100,000 traces and three people fits your budget.
Choose AcruxCore if you want a gateway, versioned tools and an audit log in a free, open-source
platform that you can also self-host, and your team can review replies on the trace page.

We ran the same agent on both platforms, with the same code, data, prompts and model. This post
gives the measured numbers for each step, then the features that only one of the two has.

We build AcruxCore. We ran every tool ourselves, and the scripts are linked below.

<!-- truncate -->

## Differences at a glance

| | AcruxCore | LangSmith |
|---|---|---|
| License | Apache 2.0, every feature | SDKs MIT; the platform is not open source |
| Self-hosting | Free, every feature | Enterprise plan only |
| Hosted price, 100,000 traces a month, 3 people | $0 during the beta; later price not set | $567 on the Plus plan |
| Hosted free plan | The whole beta; no trace or seat limit is listed | 5,000 traces a month, 1 seat |
| Trace data kept on the hosted plan | Message content 90 days; tokens, cost and timing are not deleted | 14 days; 180 days costs extra |
| Hosted regions | Not stated | GCP US, GCP EU, GCP APAC, AWS US |
| SDK languages | Python, TypeScript | Python, TypeScript, Go, Java |
| Gateway in the request path | Yes: fallbacks, cache, budgets, rate limits, virtual keys | Yes, in beta: spend limits, rate limits |
| Review queue for people | No | Yes |
| Alerts | Email: budgets, evaluation rules, weekly digest | Slack, PagerDuty, Dynatrace, webhook |
| SSO | No | Google and GitHub sign-in; custom SSO on Enterprise |
| Versioned tool catalog that the platform runs | Yes | No |

Sources, read 25 October 2026: LangSmith [pricing](https://www.langchain.com/pricing),
[self-hosting](https://docs.langchain.com/langsmith/self-hosted),
[regions](https://docs.langchain.com/langsmith/regions-faq),
[SDK reference](https://docs.langchain.com/langsmith/reference),
[LLM gateway](https://docs.langchain.com/langsmith/llm-gateway),
[alerts](https://docs.langchain.com/langsmith/alerts) and
[annotation queues](https://docs.langchain.com/langsmith/annotation-queues) pages; the
[`langsmith-sdk` repository](https://github.com/langchain-ai/langsmith-sdk) for the SDK license; and
[acruxcore.com/pricing](https://acruxcore.com/pricing). The $567 figure comes from LangSmith's
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
- **Platforms:** LangSmith on its hosted EU region, free plan, `langsmith` 0.10.10. AcruxCore on
  acruxcore.com, `acruxcore` 0.18.0.
- **Date:** 16 and 17 October 2026.

The same app also ran on Langfuse. That three-way result is in
[AcruxCore vs Langfuse vs LangSmith](https://acruxcore.com/blog/acruxcore-vs-langfuse-vs-langsmith).

## Tracing

| | AcruxCore | LangSmith |
|---|---|---|
| Lines of tracing code for this app | 15 | 18 |
| Wrapped OpenAI client | No | Yes, `wrap_openai` |
| Decorator that makes a function a step | `traces.step` | `@traceable` |
| A model call shows its prompt version | As a link: "View traces for this prompt version" | As plain metadata text |
| Calls recorded with no code in your app | Through the gateway | Through the gateway, in beta |

Both platforms stored the same tree for one message. The agent, named `scope-check`, sat at the
root. Under it came one span per step and one model call inside each step, and the price step was
marked as a tool.

![AcruxCore trace for one message: scope-check at the root, with extract, classify once for each of the two requests, a price tool and reply, each step holding a glm-5.3 LLM span, and 2,132 tokens and $0.00285 in the header](/img/blog/acruxcore-vs-langfuse-vs-langsmith/acx-trace-tree.jpg)

![LangSmith trace for the same message: scope-check at the root, with extract, two classify runs, a price tool and reply, each holding a glm-5.3 model call](/img/blog/langfuse-vs-langsmith/ls-trace-tree.jpg)

The LangSmith code is 18 lines, and 6 of those lines read the prompt. Our app does not install
`langchain-core`, so LangSmith returns each prompt as a serialized LangChain object. The 6 lines
take the messages out of that object.

The AcruxCore code is 15 lines. The AcruxCore SDK has no wrapped OpenAI client, so 4 of the 15
lines adapt the SDK's chat call to the `client.chat.completions.create` call that the app makes.

On AcruxCore, a model span has the link "View traces for this prompt version". The link opens
every trace that this prompt version produced. On LangSmith, the prompt name and commit hash appear as metadata values
on the model run.

## Tool calls

In a separate test, we built a weather agent with one tool, `get_weather`, on each platform. Both
agents called `openai/gpt-4o-mini` through OpenRouter.

On LangSmith, the tool is a Python function with `@traceable`, and your code writes the loop
that calls the model, runs the tool and calls the model again. On AcruxCore, the tool and the
prompt are stored on the platform. The gateway runs the tool, and the agent script renders the
prompt and makes one call.

| | AcruxCore | LangSmith |
|---|---|---|
| Lines in the agent script | 19 | 65 |
| Lines in the streaming agent script | 25 | 70 |
| One-time setup | 45 lines, or none in the dashboard | None |
| Cost of one run, as each platform priced it | $0.0000846 for 381 tokens | $0.0000822 for 377 tokens |

With the setup added, the two totals are close: 64 lines on AcruxCore and 65 on LangSmith. The
AcruxCore setup runs once per team. Each AcruxCore tool span also records the tool version that
ran. The full write-up is in
[Tool-call traces: LangSmith vs AcruxCore](https://acruxcore.com/blog/tool-calling-traces-langsmith-vs-acruxcore).

## Prompts, promotion and rollback

| | AcruxCore | LangSmith |
|---|---|---|
| How a chat prompt is stored | A list of role and content messages | A serialized LangChain object |
| Push a prompt from code | Python or TypeScript SDK, or REST | Needs the `langchain-core` package |
| SDK read without naming a label | Not offered; every read names an alias | Returns the newest commit, even an untested one |
| Promote a version | 4 clicks, with a confirmation | 3 clicks, with a confirmation |
| Roll back | 2 clicks on the same tab | 3 clicks |
| History of promotions | Audit tab: who moved the alias, from which version to which | Rollback list of past commits |
| SDK cache before a promotion reaches a running app | 60 seconds | 5 minutes |

On LangSmith, `push_prompt` stopped with an `ImportError` until `langchain-core` was installed.
After we committed version 2 under a `candidate` tag, a read with no tag returned version 2. A
read of `scope-extract:production` returned version 1. So on LangSmith, code that does not pin a
tag can serve a draft to users.

On AcruxCore, the SDK's `prompts.get_by_alias(name, alias)` and `prompts.render(name, alias)`
both take an alias. When you commit a prompt for the first time, AcruxCore points a `production`
and a `staging` alias at version 1. Committing version 2 does not move those aliases. AcruxCore can also fill in the template variables on the server and return the
finished messages.

![AcruxCore Audit tab for scope-extract: production moved v1 → v2, then v2 → v1, each with who made the change and when](/img/blog/acruxcore-vs-langfuse-vs-langsmith/acx-audit-promote-rollback.jpg)

![LangSmith prompt page: Environments panel with Production on commit 586b51ca and a Rollback history list of two commits](/img/blog/langfuse-vs-langsmith/ls-rollback-history.jpg)

The cache times come from each SDK's source. In LangSmith 0.10.10,
`DEFAULT_PROMPT_CACHE_TTL_SECONDS` is `5 * 60`. In the AcruxCore SDKs, `cache_ttl` defaults to
60,000 milliseconds.

## Experiments over the dataset

An experiment answers one question: after you change a prompt, which messages got better and
which got worse? We ran the app over the 30 messages with version 1, then with version 2, and
opened each platform's comparison of the two runs.

| | AcruxCore | LangSmith |
|---|---|---|
| Upload the 30 test messages | 1 call, 1.0 s | 1 call, 2.2 s |
| Run your own app code as an experiment | Yes | Yes, `evaluate` |
| Clicks to the comparison of two runs | 3, from the Evaluations page | 4, from the dataset page |
| Show only the messages whose score changed | Yes, the comparison opens that way | Yes, one click on a score counter |

On AcruxCore, version 2 fixed 2 messages on the items score and broke 2 others. The comparison
page opened on those 4 messages, with no further click.

![AcruxCore Compare per example: base v1, target v2, Changed 4 selected, two messages improved and two regressed on the items score](/img/blog/acruxcore-vs-langfuse-vs-langsmith/acx-local-compare-per-example.jpg)

![LangSmith comparison of v2 and v1 filtered to two rows, with v1's items_exact cells in red at 0.00 and v2's at 1.00](/img/blog/langfuse-vs-langsmith/ls-compare-filtered.jpg)

We do not compare the scores across the two platforms. `glm-5.3` gives a slightly different
answer each time, so a score gap between platforms is noise.

AcruxCore runs experiments in two places. A server-side experiment runs a stored prompt across
versions and models, scored by an LLM judge or by a judge prompt you write. A local run executes
your own app code and scorers through `experiments.run_local` in the Python SDK or
`experiments.runLocal` in the TypeScript SDK, and uploads the results as a run. Our app has four
steps and two scorers in Python, so it used a local run.

## Reviewing replies by hand

We asked one question about each of the 30 replies: "Would you send this reply to the client as
is?"

| | AcruxCore | LangSmith |
|---|---|---|
| Review queue | No | Yes |
| Clicks per reply | 4: open the trace, open the reply step, ▲ or ▼, go back | 2: a verdict and "Next" |
| The verdict names the question | No; a ▲/▼ rating on the step | Yes, a feedback key |
| Fix a wrong answer | A comment and a label on the trace | "Add to Dataset" adds your edited version to the dataset |

![LangSmith annotation queue: the message and the agent's output on the left, the "send as is" and "needs a fix" verdict and the automatic scores on the right](/img/blog/langfuse-vs-langsmith/ls-annotation-queue.jpg)

LangSmith's queue shows the next reply after each verdict, so a reviewer does not go back to a
list. On AcruxCore, a reviewer works from the Traces list, which shows each trace's input.

## Live traffic

We sent the 30 messages to both platforms in the same five minutes, one at a time, on
16 October 2026 between 17:17 and 17:22 UTC. Then we read the numbers back through each
platform's API.

| | AcruxCore | LangSmith |
|---|---|---|
| Latency p50 / p95 | 7.65 s / 10.64 s | 7.61 s / 11.19 s |
| Model cost per trace, paid to z.ai | $0.00162 | $0.00169 |

The latency is almost all model time, because both apps called the same z.ai endpoint. The
model cost is z.ai's bill for one message, not a platform fee. It differs because the model
wrote replies of different lengths.

On AcruxCore, 85% of the input tokens were served from z.ai's prompt cache. AcruxCore priced
those tokens at the cached rate of $0.26 per million, so the 30 traces cost $0.048 instead of
$0.088 at the full input rate.

## The gateway

A gateway sits between your app and the model providers. Your app sends every model call to one
endpoint, and the gateway forwards it, records it and applies limits.

AcruxCore's gateway is an OpenAI-compatible endpoint. It is included in the hosted beta and in
the self-hosted version. You register your own provider keys and the model names your app may
call. The gateway then gives you:

- [fallbacks](https://docs.acruxcore.com/docs/guides/automatic-model-fallbacks) to another model when a call fails;
- [budgets and per-key request and token limits](https://docs.acruxcore.com/docs/guides/set-spend-limits-with-gateway-budgets-and-rate-limits);
- virtual keys, which you give to an app in place of your provider key;
- an exact-match response cache;
- a priced trace span for every call, with no tracing code in your app.

LangSmith's [LLM gateway](https://docs.langchain.com/langsmith/llm-gateway) is in beta, as of
25 October 2026. It takes Chat Completions, Messages and Responses requests with one LangSmith
API key, and every call appears as a LangSmith trace. Its governance controls are spend limits,
rate limits and data policies. The page does not mention fallbacks or a response cache.
LangSmith's gateway runs on LangSmith Cloud in every region, and on self-hosted LangSmith when an
administrator turns it on.

Our test app called z.ai directly on both platforms, so neither gateway is in the numbers above.

## Price and hosting

| Plan | 3 people, 100,000 traces a month | Trace data kept |
|---|---|---|
| AcruxCore (hosted) | $0; free to use, no paid plan | Message content 90 days; tokens, cost and timing are not deleted |
| LangSmith Plus | $567 | 14 days; 180 days costs extra |

- LangSmith's pricing calculator gave $567 on 16 October 2026: 3 seats at $39, plus 90,000
  traces above the included 10,000. On 25 October 2026, the
  [pricing page](https://www.langchain.com/pricing) still listed $39 per seat and 10,000 included
  traces on Plus, but no longer printed the per-trace rate.
- LangSmith bills per trace. The steps inside a trace are free.
- The [AcruxCore pricing page](https://acruxcore.com/pricing) says the hosted service is free to
  use and that no paid plan exists, as of 26 October 2026.
- On both platforms, you pay the model provider yourself.

AcruxCore is open source under Apache 2.0, and the self-hosted version has every feature, for
free. LangSmith's [self-hosted version](https://docs.langchain.com/langsmith/self-hosted) is an
add-on to the Enterprise plan.

## What LangSmith does that AcruxCore doesn't

- **A review queue.** Reviewers see one reply at a time, answer a named question, and can add the
  reply to a dataset in one click. AcruxCore has no queue.
- **More SDK languages.** LangSmith has SDKs for Go and Java as well as Python and TypeScript.
- **More alert channels.** LangSmith alerts on run count, cost, errors, feedback score and
  latency, and sends them to Slack, PagerDuty, Dynatrace or a webhook. AcruxCore alerts by email
  only.
- **SSO and regions.** LangSmith offers custom SSO on Enterprise and four hosted regions.
  AcruxCore has no SSO and does not state its hosted region.
- **Published paid plans.** LangSmith sells paid plans with published prices. AcruxCore's hosted
  service is free and has no paid plan.

## What AcruxCore does that LangSmith doesn't

- **Free self-hosting with every feature**, under Apache 2.0.
- **A gateway with fallbacks and a response cache**, hosted or self-hosted, and not in beta.
- **A versioned tool catalog.** You define a tool, version it and bind it to a prompt, and the
  gateway can run it. Each tool span records the tool version that ran.
- **An audit log on every plan**, which shows who moved each alias and between which versions. The
  [audit trail guide](https://docs.acruxcore.com/docs/guides/read-the-team-audit-trail) shows it.
- **A prompt read that always names an alias**, so code cannot serve an untested version by
  default.

## Which one to choose

**Choose LangSmith** if people on your team review replies by hand every day, if you need Go or
Java, or if you need custom SSO or a chosen data region. Plan for $567 a month at 100,000 traces
and three people, and 14 days of trace data.

**Choose AcruxCore** if you want the gateway, the tool catalog and the audit log without a paid
plan, or you must self-host with every feature. Expect to review replies on the trace page, and
to receive alerts by email.

## Run it yourself

- [The AcruxCore leg and its run log](https://github.com/AcruxCore/AcruxCore/tree/main/scripts/blogs/acruxcore-vs-langfuse-vs-langsmith):
  the app, [`acruxcore_sdk_leg.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/blogs/acruxcore-vs-langfuse-vs-langsmith/python/acruxcore_sdk_leg.py),
  the dataset, both prompt versions, and the raw output of every step.
- [The LangSmith leg](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/blogs/langfuse-vs-langsmith/python/langsmith_leg.py)
  and its [run log](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/blogs/langfuse-vs-langsmith/RUNLOG.md).
- [The tool-call scripts](https://github.com/AcruxCore/AcruxCore/tree/main/scripts/blogs/tool-calling-traces-langsmith-vs-acruxcore/python)
  for both platforms.

## Further reading

- [AcruxCore vs Langfuse vs LangSmith](https://acruxcore.com/blog/acruxcore-vs-langfuse-vs-langsmith)
  adds Langfuse to the same test.
- [Langfuse vs LangSmith](https://acruxcore.com/blog/langfuse-vs-langsmith) runs the app on those
  two platforms only.
- [LangSmith alternatives](https://acruxcore.com/blog/langsmith-alternatives) covers more tools.
- [The AcruxCore Quickstart](https://docs.acruxcore.com/docs/getting-started/quickstart) goes from
  sign-up to a traced, gateway-routed call.
