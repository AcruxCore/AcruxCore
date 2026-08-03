---
title: Introduction
description: Acrux Core is one platform to version prompts, route LLM calls through a gateway, trace every request, catalog tools, and evaluate quality.
sidebar_position: 1
keywords: [llm ops, prompt management, ai gateway, llm tracing, prompt versioning, llm evaluation]
---

# What is Acrux Core?

Acrux Core is an **LLM-ops platform**: one place to manage the prompts your app
sends to language models, route those calls through a smart gateway, see exactly
what happened on every request, and measure whether changes made things better.

Everything in Acrux Core is **team-scoped** — you sign up, get a workspace, and
invite teammates. You talk to it two ways: the **web app** (for authoring and
inspection) and, from your running application, the **REST API** or one of the two
SDKs — [`@acruxcoreai/sdk`](https://www.npmjs.com/package/@acruxcoreai/sdk) for Node
and [`acruxcore`](https://pypi.org/project/acruxcore/) for Python. The two SDKs have
the same feature set, so nothing here is Node-only.

## The five building blocks

Acrux Core is built from five pieces that each stand on their own but are
designed to snap together.

| Block | What it does |
|-------|--------------|
| **Prompts** | Versioned, templated message sets. Move a `production` alias between versions without redeploying your app. |
| **Gateway** | One OpenAI-compatible endpoint in front of every provider (OpenAI, Anthropic, Gemini, OpenRouter, …). Bring your own keys; get routing, cost, and caching. |
| **Tracing** | Every gateway call is recorded as a trace with spans — model, tokens, latency, cost. Report your own spans from app code too. |
| **Tools** | Functions the model can call, versioned exactly like prompts. Declare one in your own code and the catalog fills itself in, or declare an HTTP one that the platform calls for you. |
| **Evaluation** | Build datasets from real feedback and run experiments to compare prompt or model versions on quality. |

## How they connect

The blocks form one continuous line from authoring to measurement:

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
   registers it, hands the model its schema, runs your function when the model asks
   for it, and adds a span for the call to the same trace.
5. Users thumbs-up/down the answers; you turn that feedback into a dataset and
   **evaluate** a new prompt version against it.

## Who it's for

- **App developers** who call LLMs from Node or Python and want prompts they can
  change without shipping code.
- **Teams** who need one audited, cost-visible path to every model provider.
- **Anyone** who has outgrown hard-coded prompt strings and print-statement
  debugging for LLM features.

Ready? Head to the [Quickstart](./quickstart) to make your first call in a few
minutes, or read [Core concepts](./core-concepts) for the mental model first.
