---
title: Core concepts
description: The mental model behind AcruxCore — prompt versions and aliases, gateway model resolution, traces and spans, the tool catalog and its executors, and evaluation.
sidebar_position: 4
keywords: [prompt versioning, prompt alias, ai gateway, llm trace span, tool calling, tool catalog, acrux.tool, llm evaluation]
---

# Core concepts

A short tour of the ideas you'll meet everywhere in AcruxCore.

## Prompts, versions, and aliases

A **prompt** is a named container (e.g. `support-reply`). It holds an ordered
list of **versions**. Each version is an **immutable** set of messages —
`{ role, content }` — where `content` is a template that can use
`{{ variables }}` and `{% logic %}` (Jinja-style, rendered server-side).

Because versions never change, you move a moving target — an **alias** — to point
at whichever version is live. Every prompt starts with two aliases,
`production` and `staging`. Your app asks for `support-reply` at `production`; you
promote a new version to `production` in the UI and the app picks it up **without
a redeploy**.

> Editing a prompt and committing produces a *new* version. Promotion is a
> separate, deliberate step — so a commit never silently changes what's live.

## Gateway model resolution

The **gateway** is a single OpenAI-compatible endpoint
(`POST /gateway/chat/completions`) in front of every provider. Two things get
resolved on each call:

- **Credential** — your encrypted provider key (BYOK). Supported providers:
  `openai`, `anthropic`, `gemini`, and `openai_compatible` (OpenRouter, Together,
  local servers, …).
- **Model** — a **public name** you register (e.g. `support-model`) that points at
  a credential and an upstream model id (e.g. `openai/gpt-4o-mini`). Callers send
  the public name as `model`; renaming the upstream never breaks callers.

A version can also bind a **default model**, so a stored-prompt call that omits
`model` still resolves one. Precedence: an explicit request `model` wins → else
the version's bound model → else `400 model is required`.

## Traces, spans, and sessions

Every gateway completion is recorded as a **trace** containing one or more
**spans**. A span is one unit of work — an LLM call, a tool call, a retrieval —
with its model, token usage, latency, status, and (optionally) input/output
payloads. You can also report your own spans from app code with the SDK's
`trace()` to capture whole chains. Related traces can share a **session** id so a
multi-turn conversation shows up as one thread.

A tool-calling agent lands in **one** trace rather than several: the gateway records
an `llm` span per model round-trip, and each tool call adds a `tool` span beside them.
Which side writes that span depends on where the tool ran — the SDK writes it for a
tool your own process ran, the platform writes it for one it ran itself — and either
way, a span for a catalog tool records the version that ran and the executor that ran
it.

## Tools

A **tool** is a function the model can ask you to run — `get_weather`,
`search_orders`. The model sees it in OpenAI-function shape: a name, a description,
and a JSON Schema for its arguments.

Everything else about tools comes down to three questions, and they are independent.
Keeping them apart is most of what makes the rest of this section readable:

| Question | The answer |
|---|---|
| **Who writes the definition** — the name, description and argument schema | Your code (`@acrux.tool`), or the catalog (dashboard or API) |
| **Who runs the call** | Your process (`client` executor), or AcruxCore (`http` executor) |
| **How a prompt gets the tool** | A binding, set on the prompt's Tools tab |

The one place they touch: a tool declared with `@acrux.tool` is always `client`,
because the declaration includes the function body. A tool defined in the catalog can
be either.

### The function can be the definition

Declare a tool where its code already lives, and AcruxCore derives the rest of it:

```python
@acrux.tool
async def get_weather(city: str) -> dict:
    """Get the current weather for a city.

    Args:
        city: City name, e.g. 'Lahore'.
    """
```

The name comes from the function name, the model-facing description from the
docstring's first paragraph, and the argument schema from the type hints. TypeScript
has no runtime types, so there `acrux.tool` takes the schema as a value — a zod
object or a plain JSON Schema — and hands your function typed arguments back.

This is the whole point of the shape: the schema the model reads and the arguments
your code receives come from one declaration, so they cannot drift apart. Rename an
argument and the code that uses it breaks in front of you, instead of the model
calling a field your function no longer has.

### Versions, aliases, and the catalog

Tools live in a **catalog** and are versioned exactly like prompts — immutable
versions, with `production` and `staging` aliases.

A tool is a name plus at least one version. The name alone resolves to nothing, so a
tool with no committed version cannot be called; the catalog marks that state rather
than leaving you to find out from a run. Committing the first version creates both
aliases at once, which is why creating a tool in the dashboard asks for the version in
the same step.

A declared tool needs no catalog entry written by hand. The first run **syncs** it: it
creates the entry if the name is new, commits a version, and moves the alias to it.
Sync is reconcile-or-nothing — an unchanged spec commits nothing, a changed one commits
the next version. From then on the model is served the tool as a catalog **reference**
(name + alias) rather than an inline schema. So what the model reads is what the catalog
holds, the two cannot drift apart, and every tool call can be traced back to the version
that was live when it ran.

Two fields are easy to mix up, and keeping them apart matters:

| Field | Who reads it |
|-------|--------------|
| `description` | **The model.** It is the reason the model picks this tool over another. |
| `changelog` | **Your team.** A release note on the version — never sent to the model. |

### Executors decide where a tool runs

Every version declares an **executor**, and that is what decides who runs the call:

- **`client`** — your process runs it. You supply the function at call time, under the
  tool's name: `client_tools={"get_weather": get_weather}`.
- **`http`** — AcruxCore calls a URL you declared. No local code and no deploy, and the
  platform writes the span itself with the real request and response.

The tool-calling loop resolves executors *before* the first model call, so a `client`
tool with nothing able to run it fails right away instead of halfway through a run
you already paid tokens for.

### Who owns a definition

Every path — a decorated function, the dashboard, the API — writes to the same catalog,
so each version records its **source**: `code`, `dashboard`, or `api`. The rule is that
**code wins when it syncs, but never quietly**: the dashboard marks a code-owned tool
with a *Defined in code* badge and warns before you edit it, and the SDK warns when a
sync supersedes someone's dashboard edit. Nothing is ever lost, because versions are
immutable — the superseded version stays in the list and can be promoted back.

### Binding a tool to a prompt

A prompt does not contain its tools. It **binds** them, and a binding is a small
record: *when this prompt is served through this alias, call this tool at this
version*. You set them on the prompt's Tools tab, and they take effect immediately —
there is no prompt version to commit, because a tool choice is not part of the
template.

Each binding resolves the tool one of two ways, and the difference is the whole
reason bindings exist:

- **Follow one of the tool's aliases** — usually `production`. Promoting that alias
  changes what the prompt runs, with no edit to the prompt.
- **Pin one exact version** — the prompt keeps running that build whatever the aliases
  do afterwards.

Bindings are keyed by the *prompt's* alias, not by its version. One default row is
inherited by every prompt alias, and any alias can be given its own row to override
it — which is how `staging` tries a new tool while `production` keeps the old one.
An alias with no row of its own follows the default, so promoting a new prompt alias
needs no setup at all.

A caller can also skip bindings entirely and name the tools on the request itself, as
`tool_refs`. That is the right shape when the tool set is decided at runtime rather
than by configuration.

### Which SDK call runs the tools

Three calls run a model, and the only thing that separates them is how much you are
holding already:

| You have | Call | What it does |
|---|---|---|
| Messages you wrote, no tools | `gateway.chat()` | One request, one answer |
| Messages you wrote, and the tools named on the call | `gateway.run_tool_loop()` | Calls the model, runs the tools it asks for, repeats until it answers |
| A prompt from the catalog | `prompts.render()`, then `gateway.run_prompt_with_tools()` | The same loop, with the model, the messages and the tools all read from the prompt |

The names above are the Python SDK's. Node spells the same three `chat`, `runToolLoop`
and `runPromptWithTools` — see the [Node](../sdk-reference/node) and
[Python](../sdk-reference/python) references.

`chat()` also accepts `tools`, and that is the one pairing worth knowing about: it
*offers* the definitions to the model but never runs them. The call comes back with
`finish_reason="tool_calls"` and the model's request on `message["tool_calls"]`, and
running it is yours to do. That is the right shape when you want your own loop, and the
wrong one when you expected an answer.

Once you are in the loop, a second question decides what you pass — where the
definition lives, and whose process runs the call:

| Definition lives in | Runs in | Pass |
|---|---|---|
| Your code, declared with `@acrux.tool` | Your process | `tools=[get_weather]` |
| The catalog, `http` executor | AcruxCore | Nothing — the prompt's binding is enough, or `tool_refs=[...]` to name it on the call |
| The catalog, `client` executor | Your process | `client_tools={"get_weather": get_weather}` |
| Nowhere — declared inline for this one call | Your process | `tool_defs=[...]` and `dispatch=...` |

`dispatch` is the escape hatch under all of them: one function taking a tool name and
its arguments, for when the names are not known until runtime. Everything else is a
shortcut for the common case where they are.

The loop resolves all of this before the first model call, so a mistake here costs no
tokens. A `client` tool with nothing able to run it raises `MISSING_DISPATCH` naming
the tool and the keys you did supply, rather than failing halfway through a run.

### Which page do you need

The five guides under [Tools](/docs/guides/tools) run in this order, and each one
answers a different question:

| If you want to | Read |
|---|---|
| Put a tool in the catalog, from a decorated function or from the dashboard | [Create a tool](../guides/create-a-tool) |
| Connect a catalog tool to a prompt, and give one alias its own tools | [Connect a tool to a prompt](../guides/connect-a-tool-to-a-prompt) |
| Run a prompt's bound tools from the SDK, streaming or not | [Call a prompt's tools from the SDK](../guides/call-a-prompts-tools-from-the-sdk) |
| Commit a second version, move an alias, read call volume and latency | [Version and track a tool](../guides/version-and-track-a-tool) |
| Record a failure your tool can see but the HTTP status cannot | [Report a tool failure from your own code](../guides/report-a-tool-failure-from-your-own-code) |

## Datasets, experiments, and evaluation

**Feedback** (thumbs up/down + comments) on traces is the raw material for
quality. You select feedback rows to build a **dataset** — a fixed set of
example inputs. An **experiment** runs a prompt/model combination across the
dataset and produces a **run report** you can compare against another version.
Experiment runs are processed asynchronously by a worker.

That whole loop — trace → feedback → dataset → run — starts with a person
noticing a bad answer and rating it. That works at a trickle of traffic. It
stops working once a prompt is handling thousands of calls a day: nobody is
reading all of them, so a quality drop can sit unnoticed until a customer
reports it.

An **evaluation rule** is a standing instruction ("does this reply follow up
correctly?") that a background worker checks against a sample of matching
`llm` spans as they happen, using the same LLM-as-judge the offline runs use —
no dataset, no run, no person rating anything. Its scores land on the trace
next to feedback, and its lowest scorers can be sent straight into a dataset,
so a quality drop a rule catches feeds the same fix loop a human-rated one
would. See [Score live traffic with an evaluation
rule](../guides/score-live-traffic-with-an-evaluation-rule) to set one up.

## The audit trail

A **trace** records traffic: a call your app made. An **audit event** records a
change: something a person did to the workspace. They are separate on purpose,
because they answer different questions. "Why was this answer wrong?" is a
trace. "Who moved `production` to v7 on Tuesday, and who revoked that key?" is
an audit event.

Every write the platform performs is recorded with the person behind it —
prompts and their versions and aliases, tools and their bindings, members and
invites, API keys, gateway credentials, models, virtual keys and budgets,
secrets, and the team's trace settings. Thirty-four kinds of event in all,
grouped into seven areas for filtering.

You read the trail in three places, and the scope decides who may:

| Trail | Where | Who can read it |
|-------|-------|-----------------|
| One prompt | The prompt's **Audit** tab | Any member, and an API key |
| One tool | The tool's **Audit** tab | Any member, and an API key |
| The whole team | **Team → Audit trail** | `owner` and `admin`, signed in |

The team-wide trail is the only read in the platform an API key cannot make. It
needs a signed-in session, because a record of what people did should not be
readable by a program holding a key. See [Read the team audit
trail](../guides/read-the-team-audit-trail).

## Where to go next

- **[Quickstart](./quickstart)** — make your first traced gateway call in ten minutes.
- **Feature overviews** — one page per block, with what it does and what it does not:
  [prompt management](https://acruxcore.com/features/prompts),
  [the LLM gateway](https://acruxcore.com/features/gateway),
  [LLM observability](https://acruxcore.com/features/tracing),
  [LLM tool calling](https://acruxcore.com/features/tools),
  [LLM evaluation](https://acruxcore.com/features/evaluation),
  [the audit log](https://acruxcore.com/features/audit).
- **[Tutorials](../tutorials/)** — eight end-to-end agent builds, from no-code dashboard to multi-agent systems. Start with [Level 1](../tutorials/#level-1--start-here-no-code) if you're new.
