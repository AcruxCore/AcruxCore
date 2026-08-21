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

### The function is the definition

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

You don't create the catalog entry by hand. The first run **syncs** the tool you
declared: it creates the entry if the name is new, commits a version, and moves the
alias to it. Sync is reconcile-or-nothing — an unchanged spec commits nothing, a
changed one commits the next version. From then on the model is served the tool as a
catalog **reference** (name + alias) rather than an inline schema. So what the model
reads is what the catalog holds, the two cannot drift apart, and every tool call can
be traced back to the version that was live when it ran.

Two fields are easy to mix up, and keeping them apart matters:

| Field | Who reads it |
|-------|--------------|
| `description` | **The model.** It is the reason the model picks this tool over another. |
| `changelog` | **Your team.** A release note on the version — never sent to the model. |

### Executors decide where a tool runs

Every version declares an **executor**, and that is what decides who runs the call:

- **`client`** — your process runs it. A tool declared with `acrux.tool` is always
  this, because the declaration includes the function body.
- **`http`** — the platform calls a URL you declared. No local code and no deploy,
  and the platform writes the span itself with the real request and response.

The tool-calling loop resolves executors *before* the first model call, so a `client`
tool with nothing able to run it fails right away instead of halfway through a run
you already paid tokens for.

### Who owns a definition

Tools can also be authored in the dashboard or over the API, and every path writes to
the same catalog — so each version records its **source**: `code`, `dashboard`, or
`api`. The rule is that **code wins when it syncs, but never quietly**: the dashboard
marks a code-owned tool with a *Defined in code* badge and warns before you edit it,
and the SDK warns when a sync supersedes someone's dashboard edit. Nothing is ever
lost, because versions are immutable — the superseded version stays in the list and
can be promoted back.

### Attaching a tool to a prompt

- **Client** — your app runs the tool and returns the result. Declaring it with
  `acrux.tool` is the shortest way there: the decorator derives the version's schema
  from your function, and the SDK's tool-calling loop syncs it and runs it.
- **HTTP** — the platform itself calls a URL you declare, so the tool runs
  server-side and needs no local code.

[Build and attach a tool](../guides/build-and-attach-a-tool) walks all of this
through in code.

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

## Where to go next

- **[Quickstart](./quickstart)** — make your first traced gateway call in ten minutes.
- **[Tutorials](../tutorials/)** — eight end-to-end agent builds, from no-code dashboard to multi-agent systems. Start with [Level 1](../tutorials/#level-1--start-here-no-code) if you're new.
