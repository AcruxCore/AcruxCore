---
title: Core concepts
description: "The ideas behind AcruxCore: prompt versions and aliases, gateway model resolution, traces and spans, the tool catalog and its executors, and evaluation."
sidebar_position: 4
keywords: [prompt versioning, prompt alias, ai gateway, llm trace span, tool calling, tool catalog, acrux.tool, llm evaluation]
---

# Core concepts

This page explains prompts and aliases, the gateway, traces, tools, evaluation, and
the audit trail.

## Prompts, versions, and aliases

A **prompt** is a named container (e.g. `support-reply`). It holds an ordered
list of **versions**. Each version is an **immutable** set of messages, and each
message has the shape `{ role, content }`. The `content` field is a template that can
use `{{ variables }}` and `{% logic %}`. The template uses Jinja-style syntax, and the
server renders it.

Versions never change, so you move an **alias** to point at the version you want
live. Every prompt starts with two aliases,
`production` and `staging`. Your app asks for `support-reply` at `production`. When you
promote a new version to `production` in the UI, the app uses the new version **without
a redeploy**.

> Editing a prompt and committing produces a *new* version. Promotion is a
> separate, deliberate step, so a commit never silently changes what is live.

## Gateway model resolution

The **gateway** is a single OpenAI-compatible endpoint,
`POST /gateway/chat/completions`, that sits in front of every provider. The gateway
resolves two things on each call:

- **Credential** — your own provider key (BYOK, bring your own key), stored
  encrypted. Supported providers:
  `openai`, `anthropic`, `gemini`, and `openai_compatible` (OpenRouter, Together,
  local servers, …).
- **Model** — a **public name** you register, such as `support-model`. The public
  name points at a credential and an upstream model id, such as `openai/gpt-4o-mini`.
  Callers send the public name as `model`, so changing the upstream model id never
  breaks callers.

A prompt version can also bind a **default model**, so a call to a stored prompt still
gets a model when the call leaves out `model`. The gateway picks the model in this
order: the `model` in the request, then the version's bound model. If neither is set,
the call fails with `400 model is required`.

## Traces, spans, and sessions

Every gateway completion is recorded as a **trace** containing one or more
**spans**. A span is one unit of work, such as an LLM call, a tool call, or a
retrieval. A span records its model, token usage, latency and status, and it can also
record the input and output payloads. With the SDK's `trace()`, your app code can also
report its own spans, so a whole chain of steps is captured. Related traces can share
a **session** id, so a multi-turn conversation appears as one thread.

A tool-calling agent produces **one** trace, not several. In that trace, the gateway
records an `llm` span for each model round-trip, and each tool call adds a `tool` span
next to the `llm` spans. Who writes the `tool` span depends on where the tool ran. The
SDK writes the span for a tool that your own process ran. The platform writes the span
for a tool that the platform ran itself. In both cases, the span for a catalog tool
records the tool version that ran and the executor that ran it.

## Tools

A **tool** is a function the model can ask you to run, such as `get_weather` or
`search_orders`. The model sees the tool in the OpenAI function format: a name, a
description, and a JSON Schema for its arguments.

Everything else about tools depends on three questions:

| Question | The answer |
|---|---|
| **Who writes the definition** — the name, description and argument schema | Your code (`@acrux.tool`), or the catalog (dashboard or API) |
| **Who runs the call** | Your process (`client` executor), or AcruxCore (`http` executor) |
| **How a prompt gets the tool** | A binding, set on the prompt's Tools tab |

You can combine the answers freely, with one exception. A tool declared with
`@acrux.tool` always uses the `client` executor, because the declaration includes the function body. A
tool defined in the catalog can use either executor.

### The function can be the definition

Declare a tool in the same place as its code, and AcruxCore derives the rest of the
definition from the function:

```python
@acrux.tool
async def get_weather(city: str) -> dict:
    """Get the current weather for a city.

    Args:
        city: City name, e.g. 'Lahore'.
    """
```

The name comes from the function name. The description that the model reads comes from
the first paragraph of the docstring, and the argument schema comes from the type hints.
TypeScript has no runtime types, so in TypeScript `acrux.tool` takes the schema as a
value. The schema value can be a zod object or a plain JSON Schema, and your function
receives typed arguments.

The point of declaring a tool this way is that the schema the model reads and the arguments your code
receives come from one declaration, so the schema and the arguments always match. If
you rename an argument in your function, your own code that still uses the old name
fails with an error you can see. The model never calls a field that your function no longer has.

### Versions, aliases, and the catalog

Tools live in a **catalog** and are versioned the same way as prompts, with immutable
versions and `production` and `staging` aliases.

A tool is a name plus at least one version. A name alone resolves to nothing, so a
tool with no committed version cannot be called. The catalog marks such a tool, so
you see the problem in the catalog before a run fails. Because a name alone does nothing, the
dashboard asks for the first version in the same step that creates the tool.
Committing that first version creates both aliases at once.

A tool declared with `@acrux.tool` needs no catalog entry written by hand. The first
run **syncs** the tool to the catalog. The sync creates the entry if the name is new,
commits a version, and moves the `production` alias to that version, unless you
name a different alias. A sync commits only when
something changed. An unchanged spec commits nothing, and a changed spec commits the
next version. From then on, the SDK sends the tool as a catalog **reference**, which is the
tool's name plus an alias, instead of sending the full schema. As a result, what the model reads always
matches what the catalog holds. Every tool call can also be traced back
to the version that was live when the call ran.

Two fields are easy to confuse:

| Field | Who reads it |
|-------|--------------|
| `description` | **The model.** The model uses the description to pick this tool over another. |
| `changelog` | **Your team.** A release note on the version. The changelog is never sent to the model. |

### Executors decide where a tool runs

Every tool version declares an **executor**, and the executor decides who runs the
call:

- **`client`** — your process runs it. You supply the function at call time, under the
  tool's name: `client_tools={"get_weather": get_weather}`.
- **`http`** — AcruxCore calls a URL you declared. You need no local code and no
  deploy. The platform writes the span itself, with the real request and response.

The tool-calling loop resolves executors *before* the first model call. So a `client`
tool with no function to run it fails right away, not halfway through a run you already paid
tokens for.

### Who owns a definition

A decorated function, the dashboard and the API all write to the same catalog. For
that reason, each version records its **source**: `code`, `dashboard`, or `api`. A sync
from code **moves the alias to the code's version**. Two warnings make sure nobody is
surprised by the move. The dashboard marks a code-owned tool with a *Defined in code* badge and warns before you edit the
tool. The SDK warns when a sync moves the alias away from someone's dashboard edit. Nothing is ever lost, because versions are immutable. The older version stays
in the list, and you can promote the older version back.

### Binding a tool to a prompt

A prompt does not contain its tools. A prompt **binds** its tools. A binding is a small
record: *when this prompt is served through this alias, call this tool at this
version*. You set bindings on the prompt's Tools tab, and bindings take effect
immediately. You do not commit a new prompt version, because a tool choice is not part
of the template.

Each binding resolves the tool in one of two ways:

- **Follow one of the tool's aliases** — usually `production`. Promoting that alias
  changes what the prompt runs, with no edit to the prompt.
- **Pin one exact version** — the prompt keeps running that version, even if the
  aliases move later.

Bindings are stored per *prompt alias*, not per prompt version. There is also one default
set of bindings, which every prompt alias uses unless the alias has bindings of its own. With its own bindings, `staging` can try a new tool while
`production` keeps the old one. An alias with no bindings of its own follows the
default, so a new prompt alias needs no setup.

A caller can also skip bindings entirely and name the tools on the request itself, as
`tool_refs`. `tool_refs` is the right choice when the tool set is decided at runtime
rather than by configuration.

### Which SDK call runs the tools

Three SDK calls run a model. The three calls differ only in what you already have:

| You have | Call | What it does |
|---|---|---|
| Messages you wrote, no tools | `gateway.chat()` | One request, one answer |
| Messages you wrote, and the tools named on the call | `gateway.run_tool_loop()` | Calls the model, runs the tools it asks for, repeats until it answers |
| A prompt from the catalog | `prompts.render()`, then `gateway.run_prompt_with_tools()` | The same loop, with the model, the messages and the tools all read from the prompt |

The names above are the Python SDK's. The Node SDK names the same three calls `chat`,
`runToolLoop` and `runPromptWithTools`. See the [Node](../sdk-reference/node) and
[Python](../sdk-reference/python) references.

`chat()` also accepts `tools`. With `tools`, `chat()` *offers* the definitions to the
model but never runs the tools. The call returns `finish_reason="tool_calls"`, with
the model's request on `message["tool_calls"]`. You must run the requested tools
yourself. `chat()` with `tools` is the right choice when you want your own loop, and
the wrong choice when you expect an answer.

When you use a tool loop, what you pass depends on where the definition lives and
whose process runs the call.

| Definition lives in | Runs in | Pass |
|---|---|---|
| Your code, declared with `@acrux.tool` | Your process | `tools=[get_weather]` |
| The catalog, `http` executor | AcruxCore | Nothing if the prompt binds the tool, or `tool_refs=[...]` to name it on the call |
| The catalog, `client` executor | Your process | `client_tools={"get_weather": get_weather}` |
| Nowhere — declared inline for this one call | Your process | `tool_defs=[...]` and `dispatch=...` |

`dispatch` is the most general option. `dispatch` is one function that
takes a tool name and its arguments, for when the tool names are not known until
runtime. The other options are shortcuts for the common case, where the tool names are
known in advance.

The loop resolves these choices before the first model call, so a mistake here costs
no tokens. A `client` tool with no function to run it raises `MISSING_DISPATCH` instead of
failing halfway through a run. The error names the tool and the `client_tools` keys
that you did supply.

### Which page to read

The five guides under [Tools](/docs/guides/tools) are listed below in reading order,
and each guide answers a different question:

| If you want to | Read |
|---|---|
| Put a tool in the catalog, from a decorated function or from the dashboard | [Create a tool](../guides/create-a-tool) |
| Connect a catalog tool to a prompt, and give one alias its own tools | [Connect a tool to a prompt](../guides/connect-a-tool-to-a-prompt) |
| Run a prompt's bound tools from the SDK, streaming or not | [Call a prompt's tools from the SDK](../guides/call-a-prompts-tools-from-the-sdk) |
| Commit a second version, move an alias, read call volume and latency | [Version and track a tool](../guides/version-and-track-a-tool) |
| Record a failure your tool can see but the HTTP status cannot | [Report a tool failure from your own code](../guides/report-a-tool-failure-from-your-own-code) |

## Datasets, experiments, and evaluation

Quality work starts from **feedback** on traces: a thumbs up or down, plus comments.
You select feedback rows to build a **dataset**, which is a fixed set of example
inputs. An **experiment** runs one prompt and model combination over the dataset. The
experiment produces a **run report** that you can compare against a run of another prompt version.
A worker processes experiment runs in the background.

The loop trace → feedback → dataset → run starts when a person notices a bad answer
and rates it. Rating by hand works when traffic is low. Rating by hand stops working
once a prompt handles thousands of calls a day. Nobody reads all those calls, so a
drop in quality can go unnoticed until a customer reports it.

An **evaluation rule** is a standing check, such as "does this reply follow up
correctly?". A background worker checks the rule against a sample of matching `llm`
spans as the spans happen. The worker uses the same LLM-as-judge that experiment runs
use. An evaluation rule needs no dataset, no run, and no person rating anything. The
rule's scores appear on the trace next to feedback. The results with the lowest scores
can be sent straight into a dataset. So a rule's low scores can
become dataset examples, the same way a person's ratings do. See [Score live traffic with an
evaluation rule](../guides/score-live-traffic-with-an-evaluation-rule) to set up a rule.

## The audit trail

A **trace** records traffic: a call your app made. An **audit event** records a
change: something a person did to the workspace. Traces and audit events are separate
on purpose, because they answer different questions. A trace answers "Why was this
answer wrong?". An audit event answers "Who moved `production` to v7 on Tuesday, and
who revoked that key?".

The platform records every write, together with the person who made it. The records
cover prompts and their versions and aliases, tools and their bindings, members and
invites, API keys, gateway credentials, models, virtual keys and budgets, secrets,
datasets and evaluation rules, and the team's trace settings. There are thirty-nine
kinds of event in all, grouped into eight areas for filtering.

You can read the audit trail in three places, and the scope of each place decides who
may read it:

| Trail | Where | Who can read it |
|-------|-------|-----------------|
| One prompt | The prompt's **Audit** tab | Any member, and an API key |
| One tool | The tool's **Audit** tab | Any member, and an API key |
| The whole team | **Team → Audit trail** | `owner` and `admin`, signed in |

The team-wide trail is the only thing in the platform that an API key cannot read.
Reading the team-wide trail needs a signed-in session, because a record of what people did should not be
readable by a program holding a key. See [Read the team audit
trail](../guides/read-the-team-audit-trail).

## Where to go next

- **[Quickstart](./quickstart)** — make your first traced gateway call in ten minutes.
- **Feature overviews** — one page per feature, with what the feature does and does not do:
  [prompt management](https://acruxcore.com/features/prompts),
  [the LLM gateway](https://acruxcore.com/features/gateway),
  [LLM observability](https://acruxcore.com/features/tracing),
  [LLM tool calling](https://acruxcore.com/features/tools),
  [LLM evaluation](https://acruxcore.com/features/evaluation),
  [the audit log](https://acruxcore.com/features/audit).
- **[Tutorials](../tutorials/)** — twelve end-to-end agent builds, from a no-code dashboard build to multi-agent systems. Start with [Level 1](../tutorials/#level-1--start-here-no-code) if you're new.
