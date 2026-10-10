---
title: Introduction
description: AcruxCore is one platform where you version prompts, route LLM calls through a gateway, trace every request, keep a catalog of tools, and evaluate quality.
sidebar_position: 1
keywords: [llm ops, prompt management, ai gateway, llm tracing, prompt versioning, llm evaluation]
---

# What is AcruxCore?

AcruxCore is an **LLM-ops platform**. You keep the prompts your app sends to
language models in AcruxCore, and your app calls the models through the AcruxCore
gateway. Every request is recorded, so you can see what happened. You can also
measure whether a change made the answers better.

Everything in AcruxCore belongs to a **team**. When you sign up you get a team
workspace, and you can invite teammates to it. You write prompts and inspect
results in the **web app**. Your running application talks to AcruxCore through the
**REST API** or one of two SDKs:
[`@acruxcoreai/sdk`](https://www.npmjs.com/package/@acruxcoreai/sdk) for Node and
[`acruxcore`](https://pypi.org/project/acruxcore/) for Python. The two SDKs have
the same feature set, so every feature in these docs works in Node and in Python.

## The six building blocks

AcruxCore has six pieces. You can use each piece on its own or together with
the others.

| Block | What it does |
|-------|--------------|
| [**Prompt management**](https://acruxcore.com/features/prompts) | A prompt is a set of message templates, with a new version for each change. A `production` alias points at one version. Move the alias to another version without redeploying your app. |
| [**LLM gateway**](https://acruxcore.com/features/gateway) | One OpenAI-compatible endpoint for every provider you connect: OpenAI, Anthropic, Gemini, or any other OpenAI-compatible endpoint you register. You bring your own provider keys. The gateway adds routing, fallbacks, cost tracking, and caching. |
| [**LLM observability**](https://acruxcore.com/features/tracing) | Every gateway call is recorded as a trace. The trace's spans hold the model, tokens, latency, and cost. If you call providers from your own code, you can send the same spans over OpenTelemetry instead. |
| [**LLM tool calling**](https://acruxcore.com/features/tools) | Functions the model can call, versioned the same way as prompts. Declare a tool in your own code, and AcruxCore adds the tool to the tool catalog. Or define an HTTP tool in the catalog, and AcruxCore calls the tool's URL for you. |
| [**LLM evaluation**](https://acruxcore.com/features/evaluation) | Build datasets from real feedback, by hand, or from a CSV or JSON file. Run experiments that compare prompt and model versions. Score live traffic with rules that keep running on new traces. The optimizer can draft the next prompt version for you. |
| [**Audit log**](https://acruxcore.com/features/audit) | A list of every recorded change in the team, newest first. The list covers keys, members, gateway, secrets, prompts, tools, and evaluations. You can filter it by area, event, or the person who made the change. |

## How the pieces connect

```
Author a prompt  →  call it through the gateway  →  the call is traced
      (Prompts)              (Gateway)                   (Tracing)
                                  │
                          attach tools                collect feedback
                             (Tools)                  → build a dataset
                                                       → run an experiment
                                                          (Evaluation)
```

A concrete run looks like this:

1. You author `support-reply` in the **Prompts** UI and promote v2 to `production`.
2. Your app calls the **Gateway** with a reference to that prompt. The gateway
   renders the template, picks the model, and calls the provider.
3. The call shows up in **Tracing** with its model, token counts, and latency.
4. You declare a `get_weather` **Tool** in code. The SDK's tool-calling loop
   registers `get_weather` and gives the model the tool's schema. When the model
   asks for the tool, the loop runs your function and adds a span to the same trace.
5. Users rate the answers with a thumbs up or a thumbs down. You turn those ratings
   into a dataset and **evaluate** a new prompt version against the dataset.
6. The team's **audit** trail records the promotion in step 1, the tool you
   declared, and the creation of the API key your app uses. Each entry names the person who
   made the change.

## Who it's for

- **App developers** who call LLMs from Node or Python and want prompts they can
  change without shipping code.
- **Teams** who want one path to every model provider, with the cost of each
  call shown and every change recorded.
- **Anyone** who keeps prompts as strings in code and debugs LLM features with
  print statements.

In the [Quickstart](./quickstart) you make your first call in a few minutes.
[Core concepts](./core-concepts) explains how the pieces fit together, if you
want that first.
