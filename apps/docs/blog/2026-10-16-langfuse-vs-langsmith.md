---
title: "Langfuse vs LangSmith: one app tested end to end on both"
description: "Langfuse vs LangSmith: license, self-hosting, price, retention, gateway, review queues and SSO side by side, with one app measured on both platforms."
slug: langfuse-vs-langsmith
date: 2026-10-16
authors: [acrux]
tags: [llmops-comparison, prompt-management, llm-tracing]
image: /img/blog/langfuse-vs-langsmith/header.webp
keywords: [langfuse vs langsmith, langsmith vs langfuse, langfuse or langsmith, langsmith without langchain, langfuse pricing, langsmith pricing, llm observability comparison, prompt management, llm evaluation]
last_update:
  date: 2026-10-25
---

![Langfuse vs LangSmith, one app tested on both. Langfuse: open core and free to self-host, draft-safe prompt reads, no gateway. LangSmith: closed with Enterprise-only self-hosting, a changed-score filter, a gateway in beta](/img/blog/langfuse-vs-langsmith/header.webp)

This post compares Langfuse and LangSmith on the things a developer checks before choosing one.
We also ran one app on both hosted platforms, with the same code, data, prompts and model, and
measured each step. The app is a small agent that reads a client's email, checks each request
against a signed project scope, prices the extra work, and writes a reply.

Pick Langfuse if you want an open-source platform that you can self-host for free, a large
community, and 90 days of data at a low price. Pick LangSmith if you compare experiment runs often, need Go or Java, or
want a gateway from the same vendor, and $567 a month fits your budget.

We build AcruxCore, a third tool in this space that this post does not test. We ran Langfuse and
LangSmith ourselves, and the scripts are linked below.

<!-- truncate -->

## Differences at a glance

| | Langfuse | LangSmith |
|---|---|---|
| License | MIT core; some features under a commercial license | SDKs MIT; the platform is not open source |
| Self-hosting | Free core; roles, audit log and retention policies need a license | Enterprise plan only |
| Hosted price, 100,000 traces a month, 3 people | $98.36 on the Core plan | $567 on the Plus plan |
| Data kept on that paid plan | 90 days | 14 days; 180 days costs extra |
| Hosted free plan | 50,000 units a month (a unit is a trace, a step or a score), 2 users, 30 days of data | 5,000 traces a month, 1 seat |
| Hosted regions | US, EU, Japan | US, EU, Asia-Pacific |
| SDK languages | Python, TypeScript | Python, TypeScript, Go, Java |
| Accepts traces from any OpenTelemetry exporter | Yes | Yes |
| Framework integrations | OpenAI Agents SDK, LangChain, LlamaIndex, CrewAI, Vercel AI SDK | OpenAI Agents SDK, LangChain, CrewAI, Vercel AI SDK |
| Gateway: your model calls pass through it | No | Yes, in beta: routing, spend and rate limits |
| MCP server for coding assistants | Yes: prompts, traces, datasets, scores, review queues | Yes: prompts, traces, deployments, sandboxes |
| Review queue for people | Yes | Yes |
| Alerts | Cost, latency, scores; Slack, webhook | Cost, errors, latency, feedback; Slack, PagerDuty, webhook |
| SSO | Pro plan with the Teams add-on ($300 a month), or Enterprise | Enterprise |
| Audit log | Enterprise | Enterprise |
| GitHub stars, 25 October 2026 | 36,448 | No public platform repository |
| LangChain needed | No | Not for tracing; pushing a prompt from code needs `langchain-core` |

Sources: the Langfuse [license](https://github.com/langfuse/langfuse/blob/main/LICENSE),
[pricing](https://langfuse.com/pricing), [self-hosting](https://langfuse.com/self-hosting/license-key)
and [alerts](https://langfuse.com/docs/observability/features/alerts) pages; the LangSmith
[pricing](https://www.langchain.com/pricing), [self-hosting](https://docs.langchain.com/langsmith/self-hosted),
[regions](https://docs.langchain.com/langsmith/regions-faq),
[gateway](https://docs.langchain.com/langsmith/llm-gateway) and
[alerts](https://docs.langchain.com/langsmith/alerts) pages; and the
[Langfuse MCP](https://langfuse.com/docs/api-and-data-platform/features/mcp-server) and
[LangSmith MCP](https://docs.langchain.com/langsmith/langsmith-remote-mcp) pages. Prices were read on
16 October 2026, the MCP pages on 18 October 2026, the star count on 25 October 2026, and
everything else on 17 October 2026.

## Langfuse

**Pros**

- Our app needed fewer lines of tracing and prompt-fetching code: 11, against 18 on LangSmith.
- The core is MIT-licensed and free to self-host.
- It has the larger community: 36,448 GitHub stars on 25 October 2026.
- 100,000 traces of our app cost $98.36 a month, less than a fifth of the LangSmith price.
- It keeps data for 90 days at that price.
- A model call shows its prompt name and version as a link.
- A prompt read with no label returns the `production` version, so a draft does not reach users.

**Cons**

- It has no gateway, so it cannot route model calls or stop them at a spend limit.
- Its comparison of two experiment runs cannot hide the examples whose score stayed the same.
- An experiment with a plain Python function runs one example at a time.
- The bill grows with the number of steps in each trace.
- A promotion asks for no confirmation, and the prompt page does not show past promotions.
- SSO needs a paid add-on, and the audit log needs Enterprise.

## LangSmith

**Pros**

- Its comparison of two runs filters to the examples whose score changed, in one click.
- An experiment with a plain Python function runs several examples at a time.
- It has SDKs for Go and Java as well as Python and TypeScript.
- It has a gateway, in beta.
- A promotion asks for a confirmation, and the prompt page keeps a rollback history.
- Alerts reach Slack, PagerDuty and webhooks.

**Cons**

- 100,000 traces of our app cost $567 a month.
- It keeps data for 14 days on that plan.
- The platform is not open source, and self-hosting needs the Enterprise plan.
- Pushing a prompt from code needs the `langchain-core` package.
- A prompt read with no tag returns the newest commit, so a draft can reach users.
- The SDK caches a prompt for 5 minutes, so a promotion takes up to 5 minutes to arrive.

## The setup

The tables above come from vendor pages. The sections below come from running one real app on
both platforms, so you can see how each platform behaves on a typical job.

### The app's job

A freelance developer builds a website for a yoga studio at a fixed price of $4,800. The signed
[scope](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/blogs/langfuse-vs-langsmith/data/scope.md)
lists what the price includes: five pages, a class schedule, a contact form, and 30 days of bug
fixes. After the contract is signed, the client keeps emailing for more. The app reads each email, decides which
requests the price already covers, and quotes the rest from a
[price list](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/blogs/langfuse-vs-langsmith/data/rate_card.json).

An example message and the answer the app should give:

| Client's message | Expected answer |
|---|---|
| "Please add a Spanish version of the whole site. Also a newsletter signup in the footer would be great." | Both requests are extra work: another language ($400) and a newsletter signup ($150). Total: $550. |

The app answers in four steps:

1. **Extract** splits the message into separate requests.
2. **Classify** puts each request in one of four groups:
   - covered by the signed price;
   - extra work with a price on the price list;
   - extra work with no listed price, which needs an estimate;
   - unclear.
3. **Price** adds up the extra work. This step is plain Python, with no model call.
4. **Reply** writes the email to the client.

![The app in four steps: a client email goes through extract, classify, price and reply. Classify sorts each request as covered, priced extra, needs estimate or unclear. Price is plain Python with no model call](/img/blog/langfuse-vs-langsmith/app-four-steps.webp)

### Why this app

We picked this app because each feature in the comparison has a real job in it:

| The app has | So we could test |
|---|---|
| Four steps, three with a model call | Tracing: does the trace show each step? |
| Four prompts: extract, classify and reply, plus a judge prompt that asks the model to grade each reply | Prompt versions, moving a new version to production (promotion), and rollback |
| A right answer for each message: the items and the total | Experiments with automatic scores |
| A reply that a person must approve before it is sent | Review queues for people |

### How we ran it

- **The code:** the app is one file,
  [`pipeline.py`](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/blogs/langfuse-vs-langsmith/python/pipeline.py),
  with no tracing code. Each platform's script passes three things to the app: a function that
  fetches a prompt, an OpenAI client, and a decorator that records each step in the trace. So
  the two runs differ only in these two scripts.
- **The data:**
  [30 client messages](https://github.com/AcruxCore/AcruxCore/blob/main/scripts/blogs/langfuse-vs-langsmith/data/messages.json),
  each with its expected items and total.
- **The model:** every call, the judge included, went to the model `glm-5.3` from the provider
  z.ai, through the OpenAI Python SDK.
- **The platforms:** the hosted EU region of each, on the free plans (Langfuse Hobby and
  LangSmith Developer).
- **The environments:** each platform's script ran in its own Python 3.12 environment, with
  `openai` 2.48.0 and either `langfuse` 4.14.1 or `langsmith` 0.10.10. Neither environment had a
  LangChain package.
- **One exception:** the script that pushes prompts to LangSmith needs `langchain-core`, so it
  ran in a separate environment.

## Tracing

| | Langfuse | LangSmith |
|---|---|---|
| Lines of tracing and prompt-fetching code for this app | 11 | 18, plus 2 environment variables |
| Wrapped OpenAI client | `langfuse.openai` | `wrap_openai` |
| Decorator that makes a function a step | `@observe` | `@traceable` |
| Model call shows its prompt version | "prompt: scope-extract - v1", as a link | Plain metadata text, not a link |

- Both platforms stored the same tree: the agent at the root, one span per step, and the price
  step marked as a tool. Every step except price holds one model call.
- Nine of LangSmith's 18 lines read a prompt from LangSmith without LangChain.
- On Langfuse, you pass the prompt object to `chat.completions.create`, and the call links to
  that prompt version.
- LangSmith has no argument for that link when you call the model directly. We set the metadata
  keys `lc_hub_repo` and `lc_hub_commit_hash`, as LangSmith's own `pull_prompt` does, so each
  model call shows the prompt name and commit as plain text.

![Langfuse trace for one message: scope-check at the root, with extract, two classify spans, a price tool and reply, each holding an OpenAI-generation](/img/blog/langfuse-vs-langsmith/lf-trace-tree.jpg)

![LangSmith trace for the same message: scope-check at the root, with extract, two classify runs, a price tool and reply, each holding a glm-5.3 model call](/img/blog/langfuse-vs-langsmith/ls-trace-tree.jpg)

![Langfuse generation header showing the model glm-5.3 and a link reading prompt: scope-extract - v1](/img/blog/langfuse-vs-langsmith/lf-generation-prompt-link.jpg)

![LangSmith run attributes listing lc_hub_commit_hash and lc_hub_repo scope-extract as plain metadata values](/img/blog/langfuse-vs-langsmith/ls-run-metadata-prompt.jpg)

## Do you need LangChain to use LangSmith?

| | Needs LangChain? |
|---|---|
| Tracing with `wrap_openai` and `@traceable` | No |
| Reading a prompt with `pull_prompt_commit` | No, but you unpack LangChain's format yourself |
| Pushing a prompt from code with `push_prompt` | Yes, `langchain-core` |

- LangSmith stores a prompt in LangChain's own JSON format, not as plain role and content
  messages.
- Without `langchain-core`, `push_prompt` raises `ImportError: The client.create_commit function
  requires the langchain-core package`. The prompt is still created, empty, before the error.
- Our push script runs in a separate environment with `langchain-core` 1.6.10. It builds a
  `ChatPromptTemplate` with `template_format="mustache"`, so `{{variable}}` placeholders stay as
  they are.
- Langfuse stores a chat prompt as a list of `{"role", "content"}` messages, the shape the
  OpenAI SDK takes. Our JSON prompt files came back from Langfuse unchanged.

## Prompts, promotion and rollback

| | Langfuse | LangSmith |
|---|---|---|
| How a version reaches users | Move the `production` label to it | Promote it to the Production environment |
| Prompt read with no label or tag | Returns the `production` version | Returns the newest commit, drafts included |
| Promote a version | 3 clicks, no confirmation | 3 clicks, with a confirmation |
| Roll back to the previous version | 4 clicks | 3 clicks, from a list of past commits |
| History of promotions | Not shown | Rollback list of every commit the environment pointed to |
| SDK cache before a promotion reaches the app | 60 seconds | 5 minutes |

> **Key point:** A Langfuse prompt read with no label returns the `production` version. A
> LangSmith prompt read with no tag returns the newest commit, drafts included.

![Reading a prompt with no label: Langfuse returns the production version; LangSmith returns the newest commit, so code must ask for name:production](/img/blog/langfuse-vs-langsmith/prompt-read-no-label.webp)

- After we pushed a draft v2, `pull_prompt_commit("scope-extract")` returned the draft. Code on
  LangSmith must ask for `"scope-extract:production"`.
- The app code did not change for the promotion, and the next run used v2 on both platforms.
- The cache times are the defaults in the SDK code installed by pip.

![LangSmith prompt page: Environments panel with Production on commit 586b51ca and a Rollback history list of two commits](/img/blog/langfuse-vs-langsmith/ls-rollback-history.jpg)

![Langfuse prompt page: version 2 carries the production label, and version 1 has none](/img/blog/langfuse-vs-langsmith/lf-promoted-production.jpg)

## Experiments over the dataset

An experiment runs your app on every example in a dataset and scores each result. An example
is one test message with its expected answer.

- **The scorers:** the items match the expected items exactly, the total matches exactly, and an
  LLM judge passes the reply.
- **v1 and v2:** v1 is the first set of prompts. v2 rewrites the extract and classify prompts
  from v1's mistakes. The reply and judge prompts stayed on v1, so both versions were scored the
  same way.
- **The question:** after a prompt change, how fast can you find the messages that the change
  fixed or broke?

| | Langfuse | LangSmith |
|---|---|---|
| Upload 30 examples | 30 calls, 7.3 s | 1 call, 2.2 s |
| Run your own code as an experiment | `run_experiment` | `evaluate` |
| Plain Python function, asked to run 4 at a time | Runs one at a time: 472.1 s | Runs 4 at a time: 94.3 s |
| `async` function, asked to run 4 at a time | Runs 4 at a time: 140.7 s | Not tested |
| Clicks to the comparison of two runs | 4, from the dataset page | 4, from the dataset page |
| See only the examples whose score changed | No; scan 30 rows over two pages | Yes, one click on a score column's ↑ or ↓ count |
| Examples that failed with an error | An "Error Count" column; the SDK's printed averages leave them out | A red error-rate badge next to each score average |

- Langfuse calls a plain function inside its event loop, so `max_concurrency` has no effect.
- Each example waits for the examples queued before it, and Langfuse counts that wait in the
  example's trace latency.
- This `async` task runs 4 at a time on Langfuse:

```python
async def task(*, item, **kwargs):
    return await asyncio.to_thread(app, **item.input)
```

- On the items score, v2 fixed 2 messages and broke 2 on LangSmith. On Langfuse, v2 fixed 4 and
  broke none. The screenshots below show how we found those messages.
- `glm-5.3` does not return the same output twice, so the same prompts scored differently on
  each platform. These scores compare the two prompt versions, not the two platforms.
- Both comparison views measure v1 against v2. LangSmith shows two counts per score: ↑ for
  messages where v1 scored higher, ↓ for messages where v1 scored lower.
- Langfuse shows the same two counts, as "↗0 ↘4" for the items score. Clicking a count does not
  filter the table.
- The Langfuse averages above the table cover only the 20 rows on the first page.

![LangSmith comparison of v2 and v1 filtered to two rows, with v1's items_exact cells in red at 0.00 and v2's at 1.00](/img/blog/langfuse-vs-langsmith/ls-compare-filtered.jpg)

![Langfuse comparison of the v2 run against the v1 run: a summary with averages, deltas and up/down counts, and rows with both runs' scores side by side](/img/blog/langfuse-vs-langsmith/lf-compare.jpg)

## Human review

We put the 30 traces of each v1 run into a review queue and asked one question: "Would you send
this reply to the client as is?"

| | Langfuse | LangSmith |
|---|---|---|
| Clicks per reply | 2: a verdict and "Mark Completed" | 2: a verdict and "Next" |
| Queue lists items by | ID only | ID only |
| Automatic scores beside the verdict | Hidden | Shown |
| Fix a wrong answer | "Correct output" saves your corrected text on the trace | "Add to Dataset" saves an edited example |
| Queue created before its verdict setting exists | Not possible | Succeeds, and the queue has no verdict |

- On LangSmith, create the feedback configuration first. `create_annotation_queue` names the
  configuration by its key and does not check that the configuration exists.
- Across both v1 runs, the items scorer marked 10 messages wrong. For 5 of those messages, we
  would send the reply unchanged, so the items scorer is stricter than a person.
- The total scorer agreed with us. Every reply with a wrong price failed it, and we marked each
  of those replies as needing a fix.

![LangSmith annotation queue: the message and the agent's output on the left, the "send as is" and "needs a fix" verdict and the automatic scores on the right](/img/blog/langfuse-vs-langsmith/ls-annotation-queue.jpg)

![Langfuse annotation queue: the message, output and reply as text on the left, True and False buttons for human_reply_ok on the right, and Mark Completed at the bottom](/img/blog/langfuse-vs-langsmith/lf-annotation-queue.jpg)

## Live traffic

We rolled both platforms back to v1 and sent the 30 messages to each, one at a time, during the
same 10 minutes.

| | Langfuse | LangSmith |
|---|---|---|
| Latency p50 / p95 | 16.8 s / 31.6 s | 16.9 s / 29.9 s |
| Model cost per trace, paid to z.ai | $0.0016 | $0.0018 |
| Built-in price for `glm-5.3` | None | Only for calls through Azure; our calls were recorded as OpenAI calls |
| Add a model price | Project Settings → Model Definitions: 5 clicks, 7 fields | Settings → Model pricing: 5 clicks, 7 fields |

- The latency is almost all model time, because both called the same z.ai endpoint.
- We sent this traffic on 16 October 2026, 06:03–06:13 UTC. The model's speed changes during the
  day. At 17:18 UTC the same app had a p50 of 7.2 s on Langfuse and 7.6 s on LangSmith, so
  compare the two columns with each other, not with latencies from another hour.
- The model cost is z.ai's bill for one message, not a platform fee. It differs because the
  model wrote replies of different lengths.
- We entered z.ai's prices: $1.40 per million input tokens, $0.26 per million cached input
  tokens, and $4.40 per million output tokens. Both platforms priced cached tokens at $0.26.
- Both platforms have dashboards that work with no setup. Langfuse's home page shows latency percentiles per trace, per model call and per step.
  LangSmith's trace table shows latency and cost in each row.

![LangSmith trace table for the live run: each row shows the message, the reply, latency, tokens and cost](/img/blog/langfuse-vs-langsmith/ls-traces-latency-cost.jpg)

![Langfuse home dashboard: latency percentiles p50 to p99 per trace name, per generation and per observation](/img/blog/langfuse-vs-langsmith/lf-dashboard-latency.jpg)

## What 100,000 traces a month costs

| Plan | 3 people | How it bills | Data kept |
|---|---|---|---|
| Langfuse Core ($29, 100,000 units included) | $98.36; $119.69 if each trace also gets three scores | Per unit: each trace, observation and score | 90 days |
| LangSmith Plus ($39 a seat, 10,000 traces included) | $567 | Per trace: $0.005 for each extra trace | 14 days; 180 days costs extra |

> **Key point:** For 100,000 traces a month and 3 people, Langfuse Core costs $98.36 and LangSmith
> Plus costs $567. Langfuse keeps the data for 90 days, and LangSmith keeps it for 14 days.

- Prices come from [langfuse.com/pricing](https://langfuse.com/pricing) and
  [langchain.com/pricing](https://www.langchain.com/pricing), read on 16 October 2026, using
  each page's own calculator.
- Langfuse calls each step and each model call an observation. Our live traces averaged 9.67
  units: 1 trace and 8.67 observations. 100,000 traces are 967,000 units.
- Our live traces had no scores. Scores were added only in the experiments.
- The Langfuse bill grows with the observations in a trace. An agent with 30 observations per
  trace would use about 3.1 million units for the same 100,000 traces.
- Free plans: Langfuse Hobby has 50,000 units a month, 2 users and 30 days of data. LangSmith
  Developer has 5,000 traces a month and 1 seat.

## Run it yourself

- [The scripts folder on GitHub](https://github.com/AcruxCore/AcruxCore/tree/main/scripts/blogs/langfuse-vs-langsmith):
  the agent, both platform scripts, the dataset, both prompt versions, a README with the
  commands, and `RUNLOG.md` with the raw output of every step.
- Both platforms against AcruxCore, on the same app:
  [AcruxCore vs Langfuse vs LangSmith](/blog/acruxcore-vs-langfuse-vs-langsmith).
- Each platform against AcruxCore: [AcruxCore vs Langfuse](/blog/acruxcore-vs-langfuse) and
  [AcruxCore vs LangSmith](/blog/acrux-core-vs-langsmith).
- More tools compared: [10 LLM observability tools tested hands-on](/blog/hands-on-llm-ops-comparison),
  [8 LangSmith alternatives](/blog/langsmith-alternatives) and [8 Langfuse alternatives](/blog/langfuse-alternatives).
- What self-hosting Langfuse takes next to six other self-hosted tools:
  [Self-hosting LLM observability tools: seven measured, six open source](/blog/self-hosting-llm-observability).
- At a glance: the [comparison page](https://acruxcore.com/compare) puts AcruxCore next to Langfuse and five other
  self-hostable platforms, feature by feature.
