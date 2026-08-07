---
title: "AcruxCore vs LangSmith: prompts, gateway, and tracing"
description: An honest, feature-by-feature comparison of AcruxCore and LangSmith across prompt versioning, the model gateway, tracing, tools, and evaluation.
slug: acrux-core-vs-langsmith
authors: [acrux]
tags: [comparison, langsmith, llm-ops]
image: /img/social-card.png
keywords: [AcruxCore vs langsmith, langsmith alternative, llm ops, prompt management, ai gateway, llm tracing]
---

If you're building on LLMs, you eventually need four things: prompts you can change
without redeploying, a reliable path to model providers, visibility into what each
call did, and a way to tell whether a change helped. **LangSmith** and **Acrux
Core** both address this space from different starting points. This is an honest
look at where they overlap and where they differ.

<!-- truncate -->

:::note
LangSmith is a mature, widely used product from the LangChain team. This post
compares product *shape*, not quality — the goal is to help you pick the tool that
fits how you work.
:::

## The one-line difference

**LangSmith** grew up around **tracing and evaluation**, with deep ties to the
LangChain/LangGraph ecosystem, and later added prompt management.

**AcruxCore** is built around a **runtime gateway plus prompt versioning** as the
spine, with tracing, a tool catalog, and evaluation layered on the same
team-scoped model — one continuous line from authoring to measurement.

## Prompt versioning

Both let you store prompts and version them.

- **AcruxCore** treats every version as **immutable** and uses **aliases**
  (`production`, `staging`) that you move between versions. Your app fetches
  `my-prompt@production` at runtime via the SDK; promoting a new version changes
  behavior with **no redeploy**. Prompts can also bind a default model.
- **LangSmith** offers a prompt hub with commits and tags, and is especially
  convenient if you're already pulling prompts through LangChain.

If "change the live prompt without shipping code" is a core workflow, AcruxCore's
alias model is built around exactly that.

## The model gateway

This is the biggest structural difference.

- **AcruxCore** ships an **OpenAI-compatible gateway**: one endpoint in front of
  OpenAI, Anthropic, Gemini, and any OpenAI-compatible provider (OpenRouter,
  Together, local servers). You bring your own keys (encrypted at rest), register
  public model names, and get routing, cost accounting, caching, virtual keys, and
  budgets. Your app can even send a **stored-prompt reference** and let the gateway
  render and route in one call.
- **LangSmith** does not position itself as a proxy/gateway; you typically call
  providers directly (often through LangChain) and send traces to LangSmith.

If you want a single audited, cost-visible path to every provider, that's a
first-class feature in AcruxCore rather than something you assemble yourself.

## Tracing

- **LangSmith** has deep, mature tracing — rich support for nested runs, and
  automatic instrumentation when you use LangChain/LangGraph.
- **AcruxCore** traces **every gateway call automatically** (model, tokens,
  latency, cost) and accepts **your own OTel-shaped spans** via the SDK's `trace()`
  for whole chains. Traces can be grouped into sessions, and feedback attaches to
  traces and spans.

For LangChain-heavy apps, LangSmith's automatic instrumentation is hard to beat.
For framework-agnostic apps, AcruxCore gives you tracing for free the moment you
route through the gateway.

## Tools

- **AcruxCore** has a **tool catalog**: callable functions versioned exactly like
  prompts, attached to a prompt version, with a client-side tool loop in either
  published SDK — `runToolLoop` in [`@acruxcoreai/sdk`](https://www.npmjs.com/package/@acruxcoreai/sdk)
  (TypeScript) or `run_tool_loop` in [`acruxcore`](https://pypi.org/project/acruxcore/)
  (Python) — or a gateway-run HTTP executor.
- **LangSmith** leans on LangChain's large library of tool integrations.

Different philosophies: a governed, versioned in-house catalog versus a broad
ecosystem of ready-made integrations.

## Evaluation

Both support datasets and experiments.

- **AcruxCore** builds datasets **from real production feedback** (thumbs
  up/down + comments on traces), then runs experiments that sweep
  version × model grids with an automatic production baseline.
- **LangSmith** has a rich, well-established evaluation suite with many built-in
  and custom evaluators.

LangSmith's eval tooling is broader today; AcruxCore's angle is tight coupling
between the feedback you already collect and the datasets you evaluate against.

## Hosting

- **AcruxCore** is **open source** and **self-hostable** — a standard
  **Postgres + Node** stack; BYOK keeps provider keys under your control.
- **LangSmith** is primarily a managed cloud service (with enterprise
  self-hosting options).

## Which should you pick?

- **Choose LangSmith** if you're deep in the LangChain/LangGraph ecosystem and
  want the most mature tracing and evaluation available today.
- **Choose AcruxCore** if you want prompts, a provider gateway, tracing, tools,
  and evaluation as **one integrated, open source, self-hostable platform** — and
  you value runtime prompt swaps and a single cost-visible path to every model.

Want to try the integrated story? The [Quickstart](/docs/getting-started/quickstart)
gets you from sign-up to a traced, gateway-routed call in about ten minutes.

Everything above compares product *shape* from documentation. If you want to see
the claims tested against real, hosted accounts — actual screenshots, live model
calls, real traces — read our
[hands-on comparison of LangSmith, Langfuse, PromptLayer, and AcruxCore](/blog/hands-on-llm-ops-comparison),
which also covers two platforms this post doesn't: Langfuse and PromptLayer.
