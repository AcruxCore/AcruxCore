---
title: "AcruxCore vs Langfuse vs LangSmith: one app tested end to end on all three"
description: "AcruxCore vs Langfuse vs LangSmith: license, self-hosting, price, gateway, evaluations and review queues compared, with one app measured on all three."
title_meta: "AcruxCore vs Langfuse vs LangSmith: One App, Tested"
slug: acruxcore-vs-langfuse-vs-langsmith
date: 2026-10-16
authors: [acrux]
tags: [llmops-comparison, prompt-management, llm-tracing]
image: /img/blog/acruxcore-vs-langfuse-vs-langsmith/header.webp
keywords: [acruxcore vs langfuse vs langsmith, llm observability comparison, prompt management, llm evaluation, llm tracing]
last_update:
  date: 2026-10-25
---

![AcruxCore vs Langfuse vs LangSmith, one app tested on all three. AcruxCore: open source with every feature, gateway built in, no review queue. Langfuse: open core with a big community, review queue, no gateway. LangSmith: closed platform, review queue, Go and Java SDKs](/img/blog/acruxcore-vs-langfuse-vs-langsmith/header.webp)

This post compares AcruxCore, Langfuse and LangSmith on the things a developer checks before
choosing one. We also ran one app on all three platforms, with the same code, data, prompts and
model, and measured each step. The app is a small agent that reads a client's email, checks
each request against a signed project scope, prices the extra work, and writes a reply.

We build AcruxCore, one of the three tools compared here. We ran all three ourselves, and the
scripts for every leg are linked below.

<!-- truncate -->

## Differences at a glance

| | AcruxCore | Langfuse | LangSmith |
|---|---|---|---|
| License | Apache 2.0, every feature | MIT core; some features under a commercial license | SDKs MIT; the platform is not open source |
| Self-hosting | Free, every feature | Free core; roles, audit log and retention policies need a license | Enterprise plan only |
| Hosted price, 100,000 traces a month, 3 people | $0 during the beta; later price not set | $98.36 on the Core plan | $567 on the Plus plan |
| Hosted free plan | The whole beta; no trace or seat limit on the pricing page | 50,000 units a month, 2 users (a unit is a trace, a step or a score) | 5,000 traces a month, 1 seat |
| Data kept on that hosted plan | Message content 90 days; tokens, cost and timing are not deleted | 90 days | 14 days; 180 days costs extra |
| Hosted regions | Not stated; no choice | US, EU, Japan | US, EU, Asia-Pacific |
| SDK languages | Python, TypeScript | Python, TypeScript | Python, TypeScript, Go, Java |
| OpenTelemetry ingest | Yes | Yes | Yes |
| OpenAI Agents SDK, LangChain and CrewAI integrations | Yes | Yes | Yes |
| Vercel AI SDK integration | No | Yes | Yes |
| Gateway in the request path | Yes: fallbacks, cache, budgets, rate limits | No | Yes, in beta: routing, spend and rate limits |
| Evaluations: datasets, LLM judge, your own code, live traffic | Yes | Yes | Yes |
| MCP server for coding assistants | [Yes](https://docs.acruxcore.com/docs/guides/connect-an-mcp-client): prompts (write and run), traces, experiments, tool catalog | Yes: prompts, traces, datasets, scores, review queues | Yes: prompts, traces, deployments, sandboxes |
| Review queue for people | No | Yes | Yes |
| Alerts | Email: budgets, evaluation rules, weekly digest | Cost, latency, scores; Slack, webhook | Cost, errors, latency, feedback; Slack, PagerDuty, webhook |
| SSO | No | Pro with the Teams add-on, or Enterprise | Enterprise |
| Audit log | Every plan, also self-hosted | Enterprise | Enterprise |
| GitHub stars, 17 October 2026 | 11 | 35,935 | No public platform repository |

Sources: the Langfuse [license](https://github.com/langfuse/langfuse/blob/main/LICENSE),
[pricing](https://langfuse.com/pricing), [self-hosting](https://langfuse.com/self-hosting/license-key)
and [alerts](https://langfuse.com/docs/observability/features/alerts) pages; the LangSmith
[pricing](https://www.langchain.com/pricing), [self-hosting](https://docs.langchain.com/langsmith/self-hosted),
[regions](https://docs.langchain.com/langsmith/regions-faq),
[gateway](https://docs.langchain.com/langsmith/llm-gateway) and
[alerts](https://docs.langchain.com/langsmith/alerts) pages; the
[Langfuse MCP](https://langfuse.com/docs/api-and-data-platform/features/mcp-server) and
[LangSmith MCP](https://docs.langchain.com/langsmith/langsmith-remote-mcp) pages; and
[acruxcore.com/pricing](https://acruxcore.com/pricing). The prices were read on 16 October 2026, the
MCP pages on 18 October 2026, and everything else on 17 October 2026.

## AcruxCore

**Pros**

- The hosted service is free during the beta, with no trace or seat limit.
- Every feature is open source under Apache 2.0, and self-hosting is free, with no paid features.
- The gateway sits in the request path. It has fallbacks, a cache, budgets, rate limits and
  virtual keys (keys you give an app in place of your provider key). It traces every call with
  no wrapper in your code. Our test did not use it, to match the other two legs.
- The audit log, which records who changed what, is on every plan, hosted or self-hosted.
- The comparison of two experiment runs opens on the test messages whose score changed.
- Prompts use Jinja2-style templates with `if` and `for`, and the server can fill them in.
- It has a versioned tool catalog that the gateway runs, and a built-in prompt optimizer.
- Its MCP server lets a coding assistant run a stored prompt through the gateway and then read
  the trace that the run produced.

**Cons**

- It has no review queue. In our test, reviewing one reply by hand took 4 clicks, and 2 on
  Langfuse and LangSmith.
- The Traces list shows each trace's name, not the user's message, so finding one message
  means opening rows.
- It has no SSO, and the hosted service does not state its data region.
- No price is published for after the beta.
- The community is small: 11 GitHub stars.
- Alerts arrive by email only, and there is no Vercel AI SDK integration.
- The SDK has no wrapped OpenAI client, so the test app needed 4 more lines than on Langfuse.
- A model call links to its prompt version but does not print the prompt's name or version
  number.

## Langfuse

**Pros**

- Our app needed the fewest lines of tracing code: 11.
- It has a review queue: 2 clicks per reply.
- The core is MIT-licensed and free to self-host.
- It has the largest community of the three: 35,935 GitHub stars.
- For 100,000 traces a month and 3 people, it costs $98.36 a month and keeps data for 90 days.
- A model call shows its prompt name and version as a link.
- Its MCP server works with prompts, traces, datasets, scores and review queues.

**Cons**

- It has no gateway.
- Its comparison of two experiment runs cannot hide the test messages whose score stayed the
  same.
- It bills each step and each score, so the bill grows with the number of steps in a trace.
- SSO and project roles need the paid Teams add-on, and the audit log needs Enterprise.
- A promotion asks for no confirmation, and the prompt page does not show past promotions.
- An experiment with a plain Python function runs one test message at a time.

## LangSmith

**Pros**

- It is the only one of the three with both a review queue and a filter for the test messages
  whose score changed. AcruxCore has the filter but no queue. Langfuse has the queue but no
  filter.
- It has SDKs for Go and Java as well as Python and TypeScript.
- It has a gateway, in beta.
- The prompt page keeps a rollback history.
- Alerts reach Slack, PagerDuty and webhooks.
- Its MCP server works with prompts, traces, deployments and sandboxes.

**Cons**

- For 100,000 traces a month and 3 people, it costs $567 a month, more than five times the
  Langfuse price, and keeps data for 14 days.
- The platform is not open source, and self-hosting needs the Enterprise plan.
- Pushing a prompt from code needs the `langchain-core` package.
- A prompt read with no tag returns the newest commit, not the production one, so a draft can
  reach users. Langfuse returns the production version.
- The SDK caches a prompt for 5 minutes, so a promotion takes up to 5 minutes to arrive.

## Which one to choose

Five features separate the three.

![Feature grid. Gateway: AcruxCore yes, Langfuse no, LangSmith beta. Review queue: AcruxCore no, Langfuse and LangSmith yes. Changed-score filter: AcruxCore and LangSmith yes, Langfuse no. Free self-host with all features: AcruxCore yes, Langfuse core only, LangSmith no. SSO: AcruxCore no, Langfuse paid add-on, LangSmith Enterprise](/img/blog/acruxcore-vs-langfuse-vs-langsmith/who-has-what.webp)

- **AcruxCore** if you want a free hosted service or a free self-host with every feature,
  including a gateway and an audit log, and you can work without a review queue or SSO.
- **Langfuse** if you want an open-source platform with a large community, a review queue and a
  low, known price.
- **LangSmith** if you want a review queue and the filter for changed scores in one product, or
  need Go or Java, and $567 a month fits your budget.

## How we tested

- **The app:** a small agent in four steps (extract, classify, price, reply), in one file,
  `pipeline.py`, with no tracing code in it.
  [More about the app](/blog/langfuse-vs-langsmith#the-setup).
- **The data:** 30 client messages with the expected items and total, three scorers, and two
  versions of the prompts. All three platforms got the same files.
- **The model:** every call, the judge included, went to z.ai `glm-5.3` with
  `reasoning_effort="low"`, straight from the app.
- **The platforms:** Langfuse and LangSmith on their hosted EU regions, on the free plans.
  AcruxCore on its hosted service at acruxcore.com.
- **The AcruxCore leg:** a clean environment with Python 3.12, `acruxcore` 0.18.0, `openai` 2.48.0,
  `httpx` and `python-dotenv`.

![The app runs client email through extract, classify, price and reply. The same code, data, prompts and model go to AcruxCore, Langfuse and LangSmith](/img/blog/acruxcore-vs-langfuse-vs-langsmith/one-app-three-platforms.webp)

## Tracing

| | AcruxCore | Langfuse | LangSmith |
|---|---|---|---|
| Lines of tracing code for this app | 15 | 11 | 18 |
| Wrapped OpenAI client | No | Yes | Yes |
| Decorator that makes a function a step | Yes | Yes | Yes |
| Model call shows its prompt version | A link, "View traces for this prompt version"; no name or number | "prompt: scope-extract - v1", as a link | Plain metadata text, not a link |
| Gateway that records calls with no wrapper | Yes | No | Yes, in beta |

These are all 15 lines of the AcruxCore instrumentation:

```python
from types import SimpleNamespace
from acruxcore import AcruxCoreSync

hub = AcruxCoreSync(ACX_KEY, ACX_BASE_URL, timeout=180,
                    provider={"base_url": BASE_URL, "api_key": API_KEY})

def _create(*, model, messages, acx_prompt_version=None, **params):  # a z.ai call, traced
    result = hub.gateway.chat(model, messages, prompt_version_id=acx_prompt_version, **params)
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=result.content))])

client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=_create)))

def step(name: str, kind: str):
    return hub.traces.step(name, kind=kind)

def make_app(alias: str = "production", only: set[str] | None = None):
    def get_prompt(name: str):  # `only` limits `alias` to some prompts; the rest stay on production
        version = hub.prompts.get_by_alias(name, alias if not only or name in only else "production")
        return version.messages, {"acx_prompt_version": version.id}
    return build_app(get_prompt, client, step)
```

- `ACX_KEY`, `ACX_BASE_URL`, `BASE_URL` and `API_KEY` come from environment variables.
  `build_app` is the shared app in `pipeline.py`, the same for all three platforms.
- `AcruxCoreSync` is the SDK's blocking client, for code that is not async.
- The `provider` setting gives the SDK our z.ai URL and key, so each model call goes straight
  to z.ai, as on the other two platforms.
- `traces.step` is the decorator. Each step becomes a span, and each model call becomes a span
  under its step.
- `_create` and the `client` line are the 4 lines that Langfuse does not need. The AcruxCore
  SDK has no wrapped OpenAI client, so these lines give the SDK's chat call the OpenAI shape
  that the app expects.
- The full file is
  [`acruxcore_sdk_leg.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/blogs/acruxcore-vs-langfuse-vs-langsmith/python/acruxcore_sdk_leg.py).

All three platforms stored the same tree: the agent, `scope-check`, at the root, one span per step, one model
call inside each step, and the price step marked as a tool.

![AcruxCore trace for one message: scope-check at the root, with extract, classify once for each of the two requests, a price tool and reply, each step holding a glm-5.3 LLM span, and 2,132 tokens and $0.00285 in the header](/img/blog/acruxcore-vs-langfuse-vs-langsmith/acx-trace-tree.jpg)

![AcruxCore LLM span panel showing model glm-5.3, provider api.z.ai, 791 tokens of which 704 cached prompt tokens, cost $0.000461, latency 1.93 s, and the links View traces for this prompt version and Open in Playground](/img/blog/acruxcore-vs-langfuse-vs-langsmith/acx-llm-span-prompt-link.jpg)

The AcruxCore gateway is an OpenAI-compatible endpoint in the request path:

- You point the OpenAI client at AcruxCore, and each call arrives as a priced span. Your code
  needs no wrapper.
- The gateway passes `reasoning_effort` on to the model, so a call through the gateway runs
  the model with the same settings. One extract call used 3 reasoning tokens with `"low"` and
  149 without it.
- We did not use the gateway for this test. The other two legs called z.ai directly, and the
  extra network hop would have added to AcruxCore's latency only.

## Prompts, promotion and rollback

| | AcruxCore | Langfuse | LangSmith |
|---|---|---|---|
| How a chat prompt is stored | A list of role and content messages | A list of role and content messages | A serialized LangChain object |
| Push a prompt from code | Python SDK or REST | Python SDK | Needs the `langchain-core` package |
| Promote a version | 4 clicks, with a confirmation | 3 clicks, no confirmation | 3 clicks, with a confirmation |
| Roll back | 2 clicks on the same tab | 4 clicks | 3 clicks |
| History of promotions | Audit tab: who moved the alias, and when | Not shown | Rollback list of past commits |
| SDK cache before a promotion reaches the app | 60 seconds | 60 seconds | 5 minutes |

- AcruxCore listed each prompt's variables from its `{{ }}` placeholders.
- AcruxCore created a `production` and a `staging` alias on version 1 of each prompt.
  Committing version 2 did not move them.
- `hub.prompts.get_by_alias(name, alias)` returns the version that the alias points to. AcruxCore
  can also fill in the variables on the server and return the finished messages.

![AcruxCore Audit tab for scope-extract: production moved v1 → v2, then v2 → v1, each with who made the change and when](/img/blog/acruxcore-vs-langfuse-vs-langsmith/acx-audit-promote-rollback.jpg)

## Experiments over the dataset

An experiment answers one question: after you change a prompt, which messages got better and
which got worse? We tested it like this:

- **The dataset** is 30 client messages for a fictional yoga-studio website, in
  [`messages.json`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/blogs/langfuse-vs-langsmith/data/messages.json).
  Each message has the expected answer: the extra-work items and the total price.
- **Three scorers** check each answer: are the items exactly right, is the total exactly right,
  and does an LLM judge accept the reply.
- **v1** is the first version of the prompts. **v2** is a rewrite of the extract and classify
  prompts, made after reading v1's mistakes.
- On each platform, we ran the app over the 30 messages once with v1 and once with v2, and then
  opened the platform's comparison of the two runs.

On AcruxCore, v2 fixed 2 messages and broke 2 others. The comparison has to show those 4
messages. The table shows how each platform handled that.

| | AcruxCore | Langfuse | LangSmith |
|---|---|---|---|
| Upload the 30 test messages | 1 call, 1.0 s | 30 calls, 7.3 s | 1 call, 2.2 s |
| Run your own app code as an experiment | Yes, `run_local`; our test made the same 3 REST calls itself | Yes, `run_experiment` | Yes, `evaluate` |
| Experiment runner in the SDK | Yes, `run_local`; a plain function runs 4 at a time by default | Yes; a plain function runs one message at a time | Yes; a plain function runs 4 at a time |
| Clicks to the comparison of two runs | 3, from the Evaluations page | 4, from the dataset page | 4, from the dataset page |
| See only the messages whose score changed | Yes, the comparison opens that way | No; scan all 30 rows | Yes, one click |

- We do not compare the scores across platforms. All three ran the same prompts on the same
  model, and `glm-5.3` gives a slightly different answer each time, so score gaps between
  platforms are noise. The scores of every run are in the
  [run log](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/blogs/acruxcore-vs-langfuse-vs-langsmith/RUNLOG.md).
- AcruxCore also has a server-side experiment, which runs one stored prompt over a dataset
  with an LLM judge. That kind cannot run this app, because the app has four steps and two of
  its scorers are Python code.

![AcruxCore Compare per example: base v1, target v2, Changed 4 selected, two messages improved and two regressed on the items score](/img/blog/acruxcore-vs-langfuse-vs-langsmith/acx-local-compare-per-example.jpg)

## Reviewing replies by hand

We asked one question about each of the 30 replies: "Would you send this reply to the client as
is?"

| | AcruxCore | Langfuse | LangSmith |
|---|---|---|---|
| Review queue | No | Yes | Yes |
| Clicks per reply | 4: open the trace, open the reply step, ▲ or ▼, go back | 2: a verdict and "Mark Completed" | 2: a verdict and "Next" |
| The verdict names the question | No; a ▲/▼ rating on the step | Yes, a score configuration | Yes, a feedback key |
| Fix a wrong answer | A comment and a label on the trace | "Correct output" saves your text | "Add to Dataset" adds your edited version to the dataset |

- AcruxCore's Traces list shows each trace's name, not the client's message, so finding one
  message means opening rows.
- We would send 28 of the 30 AcruxCore v1 replies unchanged.

## Live traffic

We sent the 30 messages to all three platforms during the same 5 minutes, one at a time, and
read the numbers back through each platform's API.

| | AcruxCore | Langfuse | LangSmith |
|---|---|---|---|
| Latency p50 / p95 | 7.7 s / 10.6 s | 7.2 s / 10.8 s | 7.6 s / 11.2 s |
| Model cost per trace, paid to z.ai | $0.0016 | $0.0015 | $0.0017 |
| Dashboards with no setup | Yes | Yes | Yes |

- The latency is almost all model time, because all three called the same z.ai endpoint.
- We sent this traffic on 16 October 2026, 17:18–17:22 UTC. The model's speed changes during the
  day. At 06:03 UTC the same app had a p50 of about 16.9 s on Langfuse and LangSmith
  ([Langfuse vs LangSmith](/blog/langfuse-vs-langsmith#live-traffic)), so compare the columns
  with each other, not with latencies from another hour.
- The model cost is z.ai's bill for one message, not a platform fee. It differs because the
  model wrote replies of different lengths.
- On all three platforms, we entered z.ai's prices for `glm-5.3`: $1.40 per million input
  tokens, $0.26 per million cached input tokens, and $4.40 per million output tokens.
- On AcruxCore, 85% of the input tokens were cached. At the full input price, the 30 traces
  would have cost $0.088 instead of $0.048.
- AcruxCore's Dashboards page splits requests, errors, tokens, cost and latency by day, model,
  session, prompt version or step.

![AcruxCore Traces page for the live run: each scope-check row shows its spans, tokens, cost and duration](/img/blog/acruxcore-vs-langfuse-vs-langsmith/acx-traces-latency-cost.jpg)

## Price for 100,000 traces a month

| Plan | 3 people | Data kept |
|---|---|---|
| AcruxCore Beta (hosted) | $0; no price published for after the beta | Message content 90 days; tokens, cost and timing are not deleted |
| Langfuse Core | $98.36, or $119.69 when each trace also gets three scores | 90 days |
| LangSmith Plus | $567 | 14 days; 180 days costs extra |

- Prices were read on 16 October 2026 from [acruxcore.com/pricing](https://acruxcore.com/pricing)
  and the [Langfuse and LangSmith pricing pages](/blog/langfuse-vs-langsmith#what-100000-traces-a-month-costs).
- On all three, you pay the model provider yourself.
- Langfuse bills every step in a trace, so its price grows with the number of steps. LangSmith
  bills per trace.

## Run it yourself

- [This post's scripts on GitHub](https://github.com/AcruxCore/AcruxCore/tree/main/scripts/blogs/acruxcore-vs-langfuse-vs-langsmith):
  the app, the AcruxCore leg, the dataset, both prompt versions, and `RUNLOG.md` with the raw
  output of every step.
- [The Langfuse and LangSmith legs](https://github.com/AcruxCore/AcruxCore/tree/main/scripts/blogs/langfuse-vs-langsmith),
  with their own run log.
- One platform at a time: [AcruxCore vs Langfuse](/blog/acruxcore-vs-langfuse) and
  [AcruxCore vs LangSmith](/blog/acrux-core-vs-langsmith).
- More tools compared: [10 LLM observability tools tested hands-on](/blog/hands-on-llm-ops-comparison),
  [8 LangSmith alternatives](/blog/langsmith-alternatives) and [8 Langfuse alternatives](/blog/langfuse-alternatives).
